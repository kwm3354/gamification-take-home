/**
 * The two demo tenants. Plain data with no imports: the seed (src/tenants) and the fake casino
 * (src/fake-casino) both read it. The secrets are for the demo only.
 */
export interface DemoTenant {
  id: string;
  name: string;
  platform: "A" | "B";
  ledgerNo: number;
  webhookSecret: string;
  tokenSecret: string;
  wheelSecret: string;
  platformKey: string;
}

export const demoTenants: DemoTenant[] = [
  {
    id: "alpha-casino",
    name: "Alpha Casino",
    platform: "A",
    ledgerNo: 1,
    webhookSecret: "demo-alpha-webhook-secret",
    tokenSecret: "demo-alpha-token-secret-0123456789abcdef",
    wheelSecret: "demo-alpha-wheel-secret",
    platformKey: "demo-alpha-platform-key",
  },
  {
    id: "beta-casino",
    name: "Beta Casino",
    platform: "B",
    ledgerNo: 2,
    webhookSecret: "demo-beta-webhook-secret",
    tokenSecret: "demo-beta-token-secret-0123456789abcdef",
    wheelSecret: "demo-beta-wheel-secret",
    platformKey: "demo-beta-platform-key",
  },
];

export const demoWheelSegments = [
  { label: "10 coins", coins: 10, weight: 50 },
  { label: "50 coins", coins: 50, weight: 30 },
  { label: "100 coins", coins: 100, weight: 15 },
  { label: "500 coins", coins: 500, weight: 5 },
];

export const demoStoreItems = [
  {
    code: "bonus-5-eur",
    name: "Bonus 5 EUR",
    costCoins: 500,
    reward: { type: "bonus", amountMinor: 500, currency: "EUR" },
  },
  {
    code: "bonus-1-eur",
    name: "Bonus 1 EUR",
    costCoins: 100,
    reward: { type: "bonus", amountMinor: 100, currency: "EUR" },
  },
];

/** Grant policy version 1: every deposit gives one spin. */
export const demoGrantPolicy = { minAmountMinor: 1, currencies: null, spinsPerDeposit: 1 };

/** Ops policy version 1: the alert thresholds (see src/alerts/ops-policy.ts). */
export const demoOpsPolicy = {
  pendingAgeLimitSec: 300,
  maxExpectedPrizeCoins: 100,
  maxSpinsPerPlayerPerDay: 20,
  maxPlayerRedeemShare: 0.5,
  minRedeemedForShare: 1000,
};

/**
 * Demo back office users. The passwords are demo values, shown on purpose in demo mode only
 * (the sign-in page offers them). The seed stores scrypt hashes, never these strings.
 */
export interface DemoAdmin {
  email: string;
  name: string;
  password: string;
  role: "platform_admin" | "tenant_admin" | "tenant_viewer";
  tenantId: string | null;
}

export const demoAdmins: DemoAdmin[] = [
  {
    email: "ops@demo.local",
    name: "Ops",
    password: "demo-ops-password-1",
    role: "platform_admin",
    tenantId: null,
  },
  {
    email: "manager@alpha.demo",
    name: "Alpha Manager",
    password: "demo-alpha-manager-1",
    role: "tenant_admin",
    tenantId: "alpha-casino",
  },
  {
    email: "viewer@alpha.demo",
    name: "Alpha Viewer",
    password: "demo-alpha-viewer-1",
    role: "tenant_viewer",
    tenantId: "alpha-casino",
  },
  {
    email: "manager@beta.demo",
    name: "Beta Manager",
    password: "demo-beta-manager-1",
    role: "tenant_admin",
    tenantId: "beta-casino",
  },
];
