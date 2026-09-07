# Minimize retained provider payloads

Provider events permanently retain only extracted identifiers, financial facts, processing history, and a payload hash. The complete raw payload is encrypted for troubleshooting, assigned a 30-day expiry, and then purged; provider payloads can contain sensitive details and are not the authoritative financial record.
