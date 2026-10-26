'use strict';

const crypto = require('node:crypto');
const http = require('node:http');

/**
 * SalusGateway communicates locally with the Salus UGE600 / it600 Gateway.
 * Uses AES-256-CBC encryption over local HTTP POST requests.
 */
class SalusGateway {
    /**
     * @param {object} options
     * @param {string} options.host - Gateway IP address
     * @param {number} [options.port=80] - Gateway port
     * @param {string} [options.euid='0000000000000000'] - Gateway EUID
     * @param {number} [options.timeout=8000] - Request timeout in ms
     * @param {object} [options.log] - Logger instance
     */
    constructor(options) {
        this.host = options.host;
        this.port = options.port || 80;
        this.euid = (options.euid || '0000000000000000').trim();
        this.timeout = options.timeout || 8000;
        this.log = options.log || console;

        this.iv = Buffer.from([
            0x88, 0xa6, 0xb0, 0x79, 0x5d, 0x85, 0xdb, 0xfc,
            0xe6, 0xe0, 0xb3, 0xe9, 0xa6, 0x29, 0x65, 0x4b
        ]);
        this.queue = Promise.resolve();
    }

    /**
     * Derive 256-bit AES key: MD5("Salus-" + lower(euid)) + 16 zero bytes
     * @returns {Buffer}
     */
    getKey() {
        const md5 = crypto.createHash('md5').update('Salus-' + this.euid.toLowerCase(), 'utf8').digest();
        return Buffer.concat([md5, Buffer.alloc(16, 0)]);
    }

    /**
     * Encrypt plaintext string using AES-256-CBC with PKCS7 padding
     * @param {string} plain
     * @returns {Buffer}
     */
    encrypt(plain) {
        const cipher = crypto.createCipheriv('aes-256-cbc', this.getKey(), this.iv);
        cipher.setAutoPadding(true);
        return Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    }

    /**
     * Decrypt ciphertext Buffer using AES-256-CBC
     * @param {Buffer} cipherBuf
     * @returns {string}
     */
    decrypt(cipherBuf) {
        const decipher = crypto.createDecipheriv('aes-256-cbc', this.getKey(), this.iv);
        decipher.setAutoPadding(true);
        return Buffer.concat([decipher.update(cipherBuf), decipher.final()]).toString('utf8');
    }

    /**
     * Queue requests sequentially to protect the Gateway against concurrent connections
     * @param {string} command - 'read' or 'write'
     * @param {object} body - JSON request body
     * @returns {Promise<any>}
     */
    async executeRequest(command, body) {
        return new Promise((resolve, reject) => {
            this.queue = this.queue.then(async () => {
                try {
                    const result = await this._makeRequest(command, body);
                    resolve(result);
                } catch (err) {
                    reject(err);
                }
            });
        });
    }

    _makeRequest(command, body) {
        return new Promise((resolve, reject) => {
            const jsonBody = JSON.stringify(body);
            let encData;
            try {
                encData = this.encrypt(jsonBody);
            } catch (err) {
                return reject(new Error('Encryption failed: ' + err.message));
            }

            const req = http.request({
                hostname: this.host,
                port: this.port,
                path: `/deviceid/${command}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': encData.length
                },
                timeout: this.timeout
            }, (res) => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        return reject(new Error(`Gateway returned HTTP ${res.statusCode}`));
                    }
                    try {
                        const rawBuf = Buffer.concat(chunks);
                        const decrypted = this.decrypt(rawBuf);
                        const parsed = JSON.parse(decrypted);
                        if (parsed.status !== 'success') {
                            return reject(new Error(`Gateway command rejected: ${decrypted}`));
                        }
                        resolve(parsed);
                    } catch (parseErr) {
                        reject(new Error(`Failed to decrypt/parse response: ${parseErr.message}`));
                    }
                });
            });

            req.on('timeout', () => {
                req.destroy(new Error(`Request to gateway ${this.host} timed out after ${this.timeout}ms`));
            });

            req.on('error', (err) => {
                reject(new Error(`Gateway connection error: ${err.message}`));
            });

            req.write(encData);
            req.end();
        });
    }

    /**
     * Read all devices from gateway
     * @returns {Promise<object>}
     */
    async readAll() {
        return this.executeRequest('read', { requestAttr: 'readall' });
    }

    /**
     * Set target heating temperature (in 0.5 °C steps)
     * @param {object} deviceData - { DeviceType, Endpoint, UniID }
     * @param {number} tempCelsius
     * @returns {Promise<object>}
     */
    async setHeatingTemperature(deviceData, tempCelsius) {
        const rounded = Math.round(tempCelsius * 2) / 2;
        const setpointX100 = Math.round(rounded * 100);
        return this.executeRequest('write', {
            requestAttr: 'write',
            id: [
                {
                    data: deviceData,
                    sIT600TH: {
                        SetHeatingSetpoint_x100: setpointX100
                    }
                }
            ]
        });
    }

    /**
     * Set HoldType mode:
     * 0 = Auto / Follow Schedule
     * 2 = Permanent Hold (manual target temperature)
     * 7 = Off / Standby
     * @param {object} deviceData - { DeviceType, Endpoint, UniID }
     * @param {number} holdType
     * @returns {Promise<object>}
     */
    async setHoldType(deviceData, holdType) {
        return this.executeRequest('write', {
            requestAttr: 'write',
            id: [
                {
                    data: deviceData,
                    sIT600TH: {
                        SetHoldType: Number(holdType)
                    }
                }
            ]
        });
    }

    /**
     * Set thermostat keypad lock
     * @param {object} deviceData - { DeviceType, Endpoint, UniID }
     * @param {boolean} locked
     * @returns {Promise<object>}
     */
    async setLock(deviceData, locked) {
        return this.executeRequest('write', {
            requestAttr: 'write',
            id: [
                {
                    data: deviceData,
                    sTherUIS: {
                        LockKey: locked ? 1 : 0
                    }
                }
            ]
        });
    }

    /**
     * Set switch on/off state
     * @param {object} deviceData - { DeviceType, Endpoint, UniID }
     * @param {boolean} on
     * @returns {Promise<object>}
     */
    async setSwitch(deviceData, on) {
        return this.executeRequest('write', {
            requestAttr: 'write',
            id: [
                {
                    data: deviceData,
                    sOnOffS: {
                        SetOnOff: on ? 1 : 0
                    }
                }
            ]
        });
    }
}

module.exports = SalusGateway;
