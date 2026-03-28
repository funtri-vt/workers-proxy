-- Table 1: Universal Domain Aliases
CREATE TABLE domain_aliases (
    alias_id TEXT PRIMARY KEY,
    target_domain TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_target_domain ON domain_aliases(target_domain);

-- Table 2: Secure Session Cookies (Upgraded with Full Metadata)
CREATE TABLE session_cookies (
    user_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    cookie_name TEXT NOT NULL,
    cookie_value TEXT NOT NULL,
    expires_at DATETIME,
    path TEXT DEFAULT '/',
    secure INTEGER DEFAULT 0,    -- SQLite uses 0/1 for booleans
    http_only INTEGER DEFAULT 0, -- SQLite uses 0/1 for booleans
    same_site TEXT DEFAULT 'Lax',
    PRIMARY KEY (user_id, domain, cookie_name, path)
);
CREATE INDEX idx_user_domain ON session_cookies(user_id, domain);

-- Table 3: Blacklisted Domains (Security & Abuse Prevention)
CREATE TABLE blacklisted_domains (
    domain TEXT PRIMARY KEY,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Table 4: Database Configuration (OOBE & Settings)
CREATE TABLE database_config (
    config_key TEXT PRIMARY KEY,
    config_value TEXT NOT NULL
);

-- Table 5: Migration Audit Logs
CREATE TABLE migration_audit (
    audit_id TEXT PRIMARY KEY,
    operator TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Seed Initial Configuration Data
INSERT INTO database_config (config_key, config_value) VALUES ('DATABASE_CONFIGURED', '0');
INSERT INTO database_config (config_key, config_value) VALUES ('HASH_LENGTH', '32');
