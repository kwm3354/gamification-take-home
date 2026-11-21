-- The whole schema. It is run at every start, so every statement must be safe to run twice.
-- Coins are NOT here: balances and transfers live in TigerBeetle (see docs/contracts.md).
-- Every table carries tenant_id and every query filters by it.

CREATE TABLE IF NOT EXISTS tenants (
  id                 text PRIMARY KEY,                 -- e.g. 'alpha-casino'
  name               text NOT NULL,
  platform           text NOT NULL CHECK (platform IN ('A', 'B')),
  ledger_no          integer NOT NULL UNIQUE CHECK (ledger_no > 0), -- TigerBeetle ledger of this tenant
  webhook_secret     text NOT NULL,                    -- the platform signs events with it
  token_secret       text NOT NULL,                    -- the operator signs player tokens with it
  wheel_secret       text NOT NULL,                    -- never leaves the server; wheel outcomes derive from it
  platform_url       text NOT NULL,                    -- base address of the platform's reward API
  platform_key       text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Key replacement (see "Tenant keys" in docs/contracts.md). After a replacement the old value stays
-- valid until *_prev_until. Plain ALTERs so that a database made before this change gets the columns.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS webhook_secret_prev       text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS webhook_secret_prev_until timestamptz;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS webhook_secret_rotated_at timestamptz;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS token_secret_prev         text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS token_secret_prev_until   timestamptz;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS token_secret_rotated_at   timestamptz;

-- People who sign in to the back office. The hash is scrypt (see src/admin/password.ts).
CREATE TABLE IF NOT EXISTS admin_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE CHECK (email = lower(email)),
  name          text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('platform_admin', 'tenant_admin', 'tenant_viewer')),
  tenant_id     text REFERENCES tenants(id),
  failed_logins integer NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  disabled      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'platform_admin') = (tenant_id IS NULL))
);

-- Player identity mapping: our id for the platform's id.
CREATE TABLE IF NOT EXISTS players (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text NOT NULL REFERENCES tenants(id),
  external_id  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_id)
);

-- Every event that passed the signature check, including ones we ignore. The unique key is the dedup.
CREATE TABLE IF NOT EXISTS inbound_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          text NOT NULL REFERENCES tenants(id),
  external_event_id  text NOT NULL,
  kind               text NOT NULL,                    -- 'deposit_succeeded' or 'ignored'
  player_id          uuid REFERENCES players(id),
  normalized         jsonb NOT NULL,                   -- the internal form (see src/domain/casino-platform.ts)
  raw                jsonb NOT NULL,                   -- as the platform sent it
  received_at        timestamptz NOT NULL,
  UNIQUE (tenant_id, external_event_id)
);

-- Wheel settings are versioned, never edited: a change is a new row with the next version.
CREATE TABLE IF NOT EXISTS wheel_configs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL REFERENCES tenants(id),
  version     integer NOT NULL,
  segments    jsonb NOT NULL,                          -- [{ "label": "50 coins", "coins": 50, "weight": 30 }, ...]
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, version)
);

-- Grant conditions are parameters, versioned like the wheel: a change is a new row. A spin keeps the
-- policy it was granted under. params: { "minAmountMinor": 1, "currencies": null, "spinsPerDeposit": 1 }
CREATE TABLE IF NOT EXISTS grant_policies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL REFERENCES tenants(id),
  version     integer NOT NULL,
  params      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, version)
);

-- Alert thresholds of the operator, versioned like the grant policy: a change is a new row.
-- params: { "pendingAgeLimitSec": 300, "maxExpectedPrizeCoins": 100, "maxSpinsPerPlayerPerDay": 20,
--           "maxPlayerRedeemShare": 0.5, "minRedeemedForShare": 1000 }
CREATE TABLE IF NOT EXISTS ops_policies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL REFERENCES tenants(id),
  version     integer NOT NULL,
  params      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, version)
);

-- A change of settings is an intent: proposed, then applied (by the ops policy or by us) or rejected.
-- The change is a new row of the settings table (now only wheel_configs); `result_id` points to it.
CREATE TABLE IF NOT EXISTS settings_changes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             text NOT NULL REFERENCES tenants(id),
  kind                  text NOT NULL CHECK (kind IN ('wheel_config')),
  proposed              jsonb NOT NULL,                -- { "segments": [...] }
  status                text NOT NULL CHECK (status IN ('proposed', 'applied', 'rejected')),
  expected_prize_coins  numeric NOT NULL,
  limit_coins           numeric NOT NULL,              -- maxExpectedPrizeCoins of the ops policy at proposal time
  proposed_by           text NOT NULL,                 -- 'admin/<user id>'
  decided_by            text,                          -- 'admin/<user id>' or 'policy/ops-v<N>'
  decision_note         text,
  result_id             uuid REFERENCES wheel_configs(id),
  created_at            timestamptz NOT NULL,
  decided_at            timestamptz
);
CREATE INDEX IF NOT EXISTS settings_changes_by_status ON settings_changes (status, created_at);

-- A deposit gives `spinsPerDeposit` spins, numbered by ordinal. The outcome is fixed by
-- (wheel_secret, id, wheel_config) from the start.
CREATE TABLE IF NOT EXISTS spins (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        text NOT NULL REFERENCES tenants(id),
  player_id        uuid NOT NULL REFERENCES players(id),
  source_event_id  uuid NOT NULL REFERENCES inbound_events(id),
  ordinal          integer NOT NULL DEFAULT 1,         -- 1..n among the spins of one deposit
  wheel_config_id  uuid NOT NULL REFERENCES wheel_configs(id),
  grant_policy_id  uuid REFERENCES grant_policies(id), -- the policy version that granted it
  status           text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'used')),
  segment_index    integer,
  coins            bigint,
  used_at          timestamptz,
  credited_at      timestamptz,                        -- set after the ledger confirmed the prize transfer
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_event_id, ordinal)
);
CREATE INDEX IF NOT EXISTS spins_by_player ON spins (tenant_id, player_id, created_at);

CREATE TABLE IF NOT EXISTS store_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL REFERENCES tenants(id),
  code        text NOT NULL,                           -- e.g. 'bonus-5-eur'
  name        text NOT NULL,
  cost_coins  bigint NOT NULL CHECK (cost_coins > 0),
  reward      jsonb NOT NULL,                          -- { "type": "bonus", "amountMinor": 500, "currency": "EUR" }
  active      boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code)
);

-- A redemption is an intent: created, then confirmed. See the state machine in docs/contracts.md.
CREATE TABLE IF NOT EXISTS redemptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        text NOT NULL REFERENCES tenants(id),
  player_id        uuid NOT NULL REFERENCES players(id),
  idempotency_key  text NOT NULL,
  item_id          uuid NOT NULL REFERENCES store_items(id),
  cost_coins       bigint NOT NULL,                    -- copied from the item when the intent is created
  reward           jsonb NOT NULL,                     -- copied from the item when the intent is created
  status           text NOT NULL DEFAULT 'created'
                   CHECK (status IN ('created', 'reserved', 'submitting', 'issued', 'refused', 'insufficient')),
  platform_ref     text,                               -- the platform's own id for the grant, once known
  reason           text,                               -- why refused, in the platform's words
  settled_at       timestamptz,                        -- the ledger posted (issued) or voided (refused) the reserve
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  UNIQUE (tenant_id, player_id, idempotency_key)
);

-- Queue of work that must survive a crash: ledger steps and calls to the platform.
CREATE TABLE IF NOT EXISTS outbox (
  id          bigserial PRIMARY KEY,
  tenant_id   text NOT NULL REFERENCES tenants(id),
  kind        text NOT NULL,                           -- 'spin_credit' or 'redemption_advance'
  ref_id      uuid NOT NULL,
  run_at      timestamptz NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  done_at     timestamptz,
  dead_at     timestamptz,                             -- gave up; stays visible
  UNIQUE (kind, ref_id)
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox (run_at) WHERE done_at IS NULL AND dead_at IS NULL;

-- Append-only trail of every create, update and delete, written in the same transaction as the change.
CREATE TABLE IF NOT EXISTS audit_log (
  id           bigserial PRIMARY KEY,
  tenant_id    text,                                   -- null only when the tenant itself is unknown
  actor        text NOT NULL,                          -- 'platform/<tenant>', 'player/<id>', 'system/<name>', 'admin/<name>', 'unknown'
  action       text NOT NULL,                          -- 'create', 'update', 'delete', or a named fact such as 'webhook_rejected'
  entity_type  text NOT NULL,
  entity_id    text NOT NULL,
  changes      jsonb NOT NULL DEFAULT '[]',            -- [{ "field": "status", "from": "available", "to": "used" }]
  request_id   text,
  at           timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_by_entity ON audit_log (entity_type, entity_id, id);

CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE OR REPLACE TRIGGER wheel_configs_append_only BEFORE UPDATE OR DELETE ON wheel_configs
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE OR REPLACE TRIGGER grant_policies_append_only BEFORE UPDATE OR DELETE ON grant_policies
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE OR REPLACE TRIGGER ops_policies_append_only BEFORE UPDATE OR DELETE ON ops_policies
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
