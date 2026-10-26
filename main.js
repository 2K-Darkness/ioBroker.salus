'use strict';

const utils = require('@iobroker/adapter-core');
const SalusGateway = require('./lib/salusGateway');

class SalusIt600Adapter extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'salus'
        });

        this.gateway = null;
        this.pollTimer = null;
        this.deviceDataMap = new Map();

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        // Reset connection indicator
        await this.setStateAsync('info.connection', { val: false, ack: true });

        const host = (this.config.host || '').trim();
        const euid = (this.config.euid || '0000000000000000').trim();
        const pollInterval = Math.max(10, Number(this.config.pollInterval) || 30);

        if (!host) {
            this.log.error('Gateway IP address not configured! Please configure host IP in adapter settings.');
            return;
        }

        this.log.info(`Initializing Salus iT600 Gateway at ${host} (EUID: ${euid}, Poll Interval: ${pollInterval}s)`);

        this.gateway = new SalusGateway({
            host: host,
            euid: euid,
            log: this.log
        });

        // Subscribe to writable control states
        this.subscribeStates('thermostats.*.targetTemperature');
        this.subscribeStates('thermostats.*.holdType');
        this.subscribeStates('thermostats.*.locked');

        // Initial poll
        await this.pollGateway();

        // Start polling loop
        this.startPolling(pollInterval);
    }

    startPolling(intervalSec) {
        if (this.pollTimer) {
            this.clearTimeout(this.pollTimer);
        }

        this.pollTimer = this.setTimeout(async () => {
            try {
                await this.pollGateway();
            } catch (err) {
                this.log.warn(`Error during periodic poll: ${err.message}`);
            } finally {
                this.startPolling(intervalSec);
            }
        }, intervalSec * 1000);
    }

    async pollGateway() {
        if (!this.gateway) return;

        try {
            this.log.debug('Polling data from Salus Gateway...');
            const response = await this.gateway.readAll();

            if (!response || !Array.isArray(response.id)) {
                throw new Error('Invalid or empty response from gateway');
            }

            await this.setStateAsync('info.connection', { val: true, ack: true });
            await this.setStateAsync('info.lastPoll', { val: new Date().toISOString(), ack: true });
            await this.setStateAsync('info.deviceCount', { val: response.id.length, ack: true });

            let thermostatCount = 0;
            let wiringCenterCount = 0;

            for (const item of response.id) {
                if (!item || !item.data) continue;

                const devData = item.data;
                const uniId = devData.UniID;

                // Cache device data descriptor for write commands
                if (uniId && devData) {
                    this.deviceDataMap.set(uniId, devData);
                }

                // Parse device name from sZDO.DeviceName
                let deviceName = '';
                if (item.sZDO && item.sZDO.DeviceName) {
                    try {
                        const parsed = typeof item.sZDO.DeviceName === 'string'
                            ? JSON.parse(item.sZDO.DeviceName)
                            : item.sZDO.DeviceName;
                        deviceName = parsed.deviceName || '';
                    } catch (e) {
                        deviceName = item.sZDO.DeviceName;
                    }
                }

                const basic = item.sBasicS || {};
                const devL = item.DeviceL || {};
                const model = devL.ModelIdentifier_i || basic.ModelIdentifier || 'Unknown';
                const firmware = item.sZDO?.FirmwareVersion || item.sOTA?.OTAFirmwareVersion_d || '';
                const isOnline = item.sZDOInfo?.OnlineStatus_i === 1;

                // 1. Thermostats (sIT600TH)
                if (item.sIT600TH) {
                    thermostatCount++;
                    await this.processThermostat(uniId, deviceName, model, firmware, isOnline, item.sIT600TH, devData);
                }
                // 2. Wiring Centers for underfloor heating (sIT600WC / it600WC)
                else if (item.sIT600WC || model === 'it600WC') {
                    wiringCenterCount++;
                    await this.processWiringCenter(uniId, deviceName, model, firmware, isOnline, item.sIT600WC, item.sIT600I, devData);
                }
                // 3. Salus Gateway Device (sGateway)
                else if (item.sGateway) {
                    await this.processGatewayDevice(item.sGateway, firmware, isOnline);
                }
            }

            this.log.debug(`Poll complete: ${thermostatCount} Thermostats, ${wiringCenterCount} Wiring Centers updated.`);
        } catch (err) {
            this.log.error(`Failed to poll Salus Gateway: ${err.message}`);
            await this.setStateAsync('info.connection', { val: false, ack: true });
        }
    }

    async processThermostat(uniId, name, model, firmware, isOnline, th, devData) {
        const channelId = `thermostats.${uniId}`;
        const displayName = name ? `${name} (${model})` : `Thermostat ${uniId}`;

        // Create or update Channel
        await this.extendObjectAsync(channelId, {
            type: 'channel',
            common: {
                name: displayName,
                role: 'thermostat'
            },
            native: {
                deviceData: devData,
                uniId: uniId,
                model: model
            }
        });

        // 1. Current Temperature
        const currentTemp = th.LocalTemperature_x100 !== undefined ? th.LocalTemperature_x100 / 100 : null;
        await this.ensureState(`${channelId}.currentTemperature`, 'Current Temperature', 'number', 'value.temperature', '°C', true, false);
        if (currentTemp !== null) {
            await this.setStateAsync(`${channelId}.currentTemperature`, { val: currentTemp, ack: true });
        }

        // 2. Target Temperature
        const targetTemp = th.HeatingSetpoint_x100 !== undefined ? th.HeatingSetpoint_x100 / 100 : null;
        await this.ensureState(`${channelId}.targetTemperature`, 'Target Temperature', 'number', 'level.temperature', '°C', true, true, {
            min: 5,
            max: 35,
            step: 0.5
        });
        if (targetTemp !== null) {
            await this.setStateAsync(`${channelId}.targetTemperature`, { val: targetTemp, ack: true });
        }

        // 3. Humidity (SQ610 stores relative humidity in SunnySetpoint_x100)
        if (th.SunnySetpoint_x100 !== undefined && th.SunnySetpoint_x100 !== null) {
            // SunnySetpoint_x100 is e.g. 58 representing 58%
            const humidity = th.SunnySetpoint_x100;
            await this.ensureState(`${channelId}.humidity`, 'Relative Humidity', 'number', 'value.humidity', '%', true, false, {
                min: 0,
                max: 100
            });
            await this.setStateAsync(`${channelId}.humidity`, { val: humidity, ack: true });
        }

        // 4. Heating Active (RunningState % 2 !== 0 => heating active)
        const isHeating = th.RunningState !== undefined ? (th.RunningState % 2 !== 0) : false;
        await this.ensureState(`${channelId}.heating`, 'Heating Active', 'boolean', 'indicator.working', '', true, false);
        await this.setStateAsync(`${channelId}.heating`, { val: isHeating, ack: true });

        // 5. Running State (raw value)
        if (th.RunningState !== undefined) {
            await this.ensureState(`${channelId}.runningState`, 'Running State', 'number', 'value', '', true, false);
            await this.setStateAsync(`${channelId}.runningState`, { val: th.RunningState, ack: true });
        }

        // 6. Hold Type / Operating Mode
        // 0: Schedule / Auto, 2: Permanent Hold, 7: Off / Standby
        if (th.HoldType !== undefined) {
            await this.ensureState(`${channelId}.holdType`, 'Operating Mode / Hold Type', 'number', 'level.mode.thermostat', '', true, true, {
                states: {
                    0: 'Follow Schedule / Auto',
                    2: 'Permanent Hold',
                    7: 'Off / Standby'
                }
            });
            await this.setStateAsync(`${channelId}.holdType`, { val: th.HoldType, ack: true });
        }

        // 7. Keypad Lock
        const isLocked = th.LockKey === 1;
        await this.ensureState(`${channelId}.locked`, 'Keypad Lock', 'boolean', 'switch.lock', '', true, true);
        await this.setStateAsync(`${channelId}.locked`, { val: isLocked, ack: true });

        // 8. Device Online
        await this.ensureState(`${channelId}.online`, 'Online Status', 'boolean', 'indicator.reachable', '', true, false);
        await this.setStateAsync(`${channelId}.online`, { val: isOnline, ack: true });

        // 9. Battery Level (if battery powered)
        if (th.BatteryLevel && th.BatteryLevel > 0) {
            await this.ensureState(`${channelId}.battery`, 'Battery Level', 'number', 'value.battery', '%', true, false, {
                min: 0,
                max: 100
            });
            await this.setStateAsync(`${channelId}.battery`, { val: th.BatteryLevel, ack: true });
        }

        // 10. Device Metadata
        await this.ensureState(`${channelId}.model`, 'Model Identifier', 'string', 'info.model', '', true, false);
        await this.setStateAsync(`${channelId}.model`, { val: model, ack: true });

        if (firmware) {
            await this.ensureState(`${channelId}.firmware`, 'Firmware Version', 'string', 'info.firmware', '', true, false);
            await this.setStateAsync(`${channelId}.firmware`, { val: String(firmware), ack: true });
        }
    }

    async processWiringCenter(uniId, name, model, firmware, isOnline, wc, it600i, devData) {
        const channelId = `wiringCenters.${uniId}`;
        const displayName = name ? `${name} (Wiring Center)` : `Wiring Center ${uniId}`;

        await this.extendObjectAsync(channelId, {
            type: 'channel',
            common: {
                name: displayName,
                role: 'heating'
            },
            native: {
                deviceData: devData,
                uniId: uniId,
                model: model
            }
        });

        // Online Status
        await this.ensureState(`${channelId}.online`, 'Online Status', 'boolean', 'indicator.reachable', '', true, false);
        await this.setStateAsync(`${channelId}.online`, { val: isOnline, ack: true });

        // Error code
        const errorCode = wc?.ErrorCodeWC_d || '0000';
        await this.ensureState(`${channelId}.errorCode`, 'Error Code', 'string', 'info.status', '', true, false);
        await this.setStateAsync(`${channelId}.errorCode`, { val: errorCode, ack: true });

        const hasError = errorCode !== '0000';
        await this.ensureState(`${channelId}.hasError`, 'Fault Indicator', 'boolean', 'indicator.alarm', '', true, false);
        await this.setStateAsync(`${channelId}.hasError`, { val: hasError, ack: true });

        // Firmware
        if (firmware) {
            await this.ensureState(`${channelId}.firmware`, 'Firmware Version', 'string', 'info.firmware', '', true, false);
            await this.setStateAsync(`${channelId}.firmware`, { val: String(firmware), ack: true });
        }

        // Signal RSSI / LQI if available
        if (it600i && it600i.LastMessageRSSI_d !== undefined) {
            await this.ensureState(`${channelId}.rssi`, 'Signal RSSI', 'number', 'value.signal', 'dBm', true, false);
            await this.setStateAsync(`${channelId}.rssi`, { val: it600i.LastMessageRSSI_d, ack: true });
        }
    }

    async processGatewayDevice(gw, firmware, isOnline) {
        const deviceId = 'gateway';

        await this.extendObjectAsync(deviceId, {
            type: 'device',
            common: {
                name: 'Salus Gateway (UGE600)',
                role: 'info'
            },
            native: {}
        });

        const mac = gw.NetworkLANMAC || '';
        if (mac) {
            await this.ensureState(`${deviceId}.mac`, 'LAN MAC Address', 'string', 'info.mac', '', true, false);
            await this.setStateAsync(`${deviceId}.mac`, { val: mac, ack: true });
        }

        const model = gw.ModelIdentifier || 'UGE600';
        await this.ensureState(`${deviceId}.model`, 'Gateway Model', 'string', 'info.model', '', true, false);
        await this.setStateAsync(`${deviceId}.model`, { val: model, ack: true });

        if (firmware) {
            await this.ensureState(`${deviceId}.firmware`, 'Gateway Firmware', 'string', 'info.firmware', '', true, false);
            await this.setStateAsync(`${deviceId}.firmware`, { val: String(firmware), ack: true });
        }

        await this.ensureState(`${deviceId}.online`, 'Gateway Online', 'boolean', 'indicator.reachable', '', true, false);
        await this.setStateAsync(`${deviceId}.online`, { val: true, ack: true });
    }

    async ensureState(id, name, type, role, unit, read, write, extra = {}) {
        await this.setObjectNotExistsAsync(id, {
            type: 'state',
            common: {
                name: name,
                type: type,
                role: role,
                unit: unit || undefined,
                read: read,
                write: write,
                ...extra
            },
            native: {}
        });
    }

    async onStateChange(id, state) {
        if (!state || state.ack) {
            return;
        }

        this.log.debug(`State changed: ${id} => ${state.val}`);

        if (!this.gateway) {
            this.log.warn('Gateway client not ready; cannot process command');
            return;
        }

        // Match: salus-it600.0.thermostats.<uniId>.<param>
        const parts = id.split('.');
        const adapterPrefix = `${this.name}.${this.instance}`;
        const relativeId = id.startsWith(adapterPrefix + '.') ? id.slice(adapterPrefix.length + 1) : id;
        const segments = relativeId.split('.');

        if (segments[0] === 'thermostats' && segments.length === 3) {
            const uniId = segments[1];
            const param = segments[2];

            let devData = this.deviceDataMap.get(uniId);
            if (!devData) {
                // Try to load from object native
                const obj = await this.getObjectAsync(`thermostats.${uniId}`);
                if (obj && obj.native && obj.native.deviceData) {
                    devData = obj.native.deviceData;
                    this.deviceDataMap.set(uniId, devData);
                }
            }

            if (!devData) {
                this.log.error(`Cannot send command: device data for UniID ${uniId} not found`);
                return;
            }

            try {
                if (param === 'targetTemperature') {
                    const temp = Number(state.val);
                    this.log.info(`Setting target temperature for ${uniId} to ${temp} °C`);
                    await this.gateway.setHeatingTemperature(devData, temp);
                    await this.setStateAsync(id, { val: temp, ack: true });
                } else if (param === 'holdType') {
                    const holdType = Number(state.val);
                    this.log.info(`Setting holdType for ${uniId} to ${holdType}`);
                    await this.gateway.setHoldType(devData, holdType);
                    await this.setStateAsync(id, { val: holdType, ack: true });
                } else if (param === 'locked') {
                    const locked = Boolean(state.val);
                    this.log.info(`Setting lock status for ${uniId} to ${locked}`);
                    await this.gateway.setLock(devData, locked);
                    await this.setStateAsync(id, { val: locked, ack: true });
                }
            } catch (err) {
                this.log.error(`Failed to execute ${param} on ${uniId}: ${err.message}`);
            }
        }
    }

    onUnload(callback) {
        try {
            if (this.pollTimer) {
                this.clearTimeout(this.pollTimer);
                this.pollTimer = null;
            }
            this.setState('info.connection', { val: false, ack: true });
            this.log.info('Salus iT600 adapter stopped.');
            callback();
        } catch (e) {
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options) => new SalusIt600Adapter(options);
} else {
    // Start instance directly
    new SalusIt600Adapter();
}
