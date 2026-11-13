**Report generated:** 2026-11-13 10:40:00
**Adapter:** ioBroker.salus
**Version reviewed:** 0.1.7
**Repository:** https://github.com/2K-Darkness/ioBroker.salus (tag v0.1.7)
**Previous review:** AdapterReview_salus_20261112_151500.md
**Checklist version:** ioBroker Adapter Checklist V3.5
**Skill version:** 1.16.0
**Reviewer:** Claude Sonnet 4.6 / automated review

## Status of Previous Review Findings

- EUID logged at info level: fixed (lowered to debug level, info log contains only host and poll interval)
- Dead code — setSwitch method never called: fixed (removed unused setSwitch method)
- Plain setTimeout / clearTimeout: fixed (replaced with this.setTimeout / this.clearTimeout)

## Full Re-Review Results (Checklist V3.5)

#### ✅ PASS items

- [x] Documentation & README
- [x] Icon (unique, correct file format)
- [x] Metadata — io-package.json / package.json
- [x] Object IDs & Object Structure (FORBIDDEN_CHARS sanitization, English IDs, valid hierarchy, no outside-namespace writes)
- [x] State Roles & Attributes (all roles validated against stateroles.md; all role/type/write/read constraints pass)
- [x] Language & Translations (11 required languages present; all translations verified as non-copy-of-English; no unused keys)
- [x] Admin UI (jsonConfig.json with i18n:true; fields complete and consistent with schema)
- [x] adminTab: Not present — nothing to check
- [x] Source Code Structure (compact mode export, daemon mode, no onObjectChange handler)
- [x] State Change Handling (ack guard in place; all subscribed states handled in onStateChange)
- [x] Networking & HTTP (node:http with explicit 8000 ms timeout and req.on('timeout') error path; no axios)
- [x] Timers & Intervals (this.setTimeout / this.clearTimeout loops, not setInterval; loop terminated on adapter stop)
- [x] Security & Integrity (poll interval clamped 10–3600 s; EUID not exposed at info level; no install hooks in package.json)
- [x] Code Quality (in-memory caching preventing database bloat; unused setSwitch removed)
- [x] Object Dump Validation (99 objects; hierarchy valid; roles valid; no case-collision IDs)
- [x] Dynamic Object Validation (all ensureState calls have correct role/type/write/read; parent chain valid for all dynamic objects)

#### 🔴 ACTIONABLE FINDINGS

none

#### ⚠️ OBSERVATIONS

- Gateway local HTTP interface: The embedded web server of the Salus UGE600 gateway handles requests sequentially. The adapter implements a sequential request queue to protect the gateway against concurrent request overload.
