**Report generated:** 2026-11-12 15:15:00
**Adapter:** ioBroker.salus
**Version reviewed:** 0.1.6
**Repository:** https://github.com/2K-Darkness/ioBroker.salus (tag v0.1.6)
**Previous review:** none
**Checklist version:** ioBroker Adapter Checklist V3.5
**Skill version:** 1.14.0
**Reviewer:** Claude Sonnet 4.6 / automated review

## Status of Previous Review Findings

No previous review.

## Full Re-Review Results (Checklist V3.5)

#### ✅ PASS items

- [x] Documentation & README: English README, manufacturer link, no raw npm/git install commands, license text link, free license
- [x] Icon: Unique 512x512 RGBA PNG icon matching file extension
- [x] Metadata: package.json structure, keywords, repository, author email and engines (Node >= 22.0.0)
- [x] Metadata: io-package.json schema, common.type (climate-control), connectionType (local), dataSource (poll), compact mode enabled, tier 3, licenseInformation free MIT
- [x] Dependencies: Up-to-date dependencies (@iobroker/adapter-core 3.4.3, @iobroker/testing 6.3.0), no disallowed install hooks
- [x] Admin UI: Responsive jsonConfig.json configuration with schema validation
- [x] adminTab: Not present — nothing to check
- [x] Translations: Complete translations in all 11 required languages across jsonConfig and io-package.json (en, de, ru, pt, nl, fr, it, es, pl, uk, zh-cn)
- [x] Source code structure: Standard JavaScript root layout (main.js, lib/), cleanly structured classes
- [x] Object hierarchy: Valid ioBroker tree structure (folder -> channel/device -> state), no states with children, no device under channel
- [x] Object IDs & naming: Valid English object IDs, external UniID defensively sanitized against FORBIDDEN_CHARS
- [x] State roles & attributes: All state roles and common types/attributes verified against official stateroles.md reference
- [x] State change handling: All writable states (targetTemperature, holdType, locked) subscribed and handled with ack flag check and acknowledgement
- [x] Networking & timeouts: Sequential request queue to avoid gateway concurrency, explicit HTTP timeouts configured
- [x] Timers & intervals: Proper non-zero bounded pollInterval validation, loop execution managed with timeouts
- [x] Sensitive data: No secrets or credentials logged
- [x] Security & integrity: No child process execution, no dynamic code download, no unsafe filesystem access
- [x] Code quality: In-memory object caching (setObjectNotExistsAsync) preventing database bloat, clean unload handling
- [x] Object dump validation: Attached object dump verified against adapter source code and live installation (99 objects, 0 errors, 0 warnings)

#### 🔴 ACTIONABLE FINDINGS

none

#### ⚠️ OBSERVATIONS

- Gateway local HTTP interface: The embedded web server of the Salus UGE600 gateway handles requests sequentially. The adapter implements a sequential request queue to protect the gateway against concurrent request overload.
