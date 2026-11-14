// Shared API contract. Change it on main only, and tell the team when you do.

export type Transaction = {
  customerId: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM:SS
  category: string;
  amount: number; // negative = money out
  balanceAfter: number;
  type: string;
  merchantId: string | null;
  mcc: string | null;
};

export type BasketId = "regular" | "irregular" | "everyday";

export type DemoCustomer = {
  customerId: string;
  displayName: string; // invented label; the dataset has no names
  age: number;
  postalCode: string;
  area: string;
};

export type CategoryTotal = {
  category: string;
  basket: BasketId;
  reason: string; // why this category sits in this basket
  monthlyAvg: number;
  count: number;
  peerMonthlyAvg: number | null;
};

export type BasketSummary = {
  id: BasketId;
  label: string;
  description: string;
  monthlyAvg: number;
  share: number; // 0..1 of total spending
  categories: CategoryTotal[];
};

export type MonthPoint = {
  month: string; // YYYY-MM
  income: number;
  regular: number;
  irregular: number;
  everyday: number;
  saved: number;
  endBalance: number;
};

export type Confidence = "high" | "medium" | "low";

export type RecurringBill = {
  id: string;
  category: string;
  guessLabel: string; // Sisu's guess; the user can correct it
  monthlyAvg: number;
  min: number;
  max: number;
  typicalDay: number;
  monthsSeen: number;
  windowMonths: number;
  confidence: Confidence;
  basis: string;
};

export type CalcStep = { label: string; amount: number; basis: string };

export type SafeToSpend = {
  perWeek: number;
  perMonth: number;
  steps: CalcStep[];
  actualEverydayPerMonth: number;
  gapPerMonth: number; // positive = room left, negative = overspending
};

export type EvidenceFilter = {
  from: string;
  to: string;
  category?: string;
  basket?: BasketId;
  mcc?: string;
  negativeBalance?: boolean;
};

export type Insight = {
  id: string;
  title: string;
  body: string;
  evidence: EvidenceFilter;
};

export type Overview = {
  customerId: string;
  displayName: string;
  age: number;
  postalCode: string;
  ageBand: string;
  peerCount: number;
  dataTimestamp: string;
  currency: "EUR";
  windowMonths: number;
  windowFrom: string;
  windowTo: string;
  balance: number;
  monthlyIncome: number;
  monthlySpending: number;
  monthlySaved: number;
  monthlyMandatory: number;
  monthlyEveryday: number;
  runwayMonths: number;
  baskets: BasketSummary[];
  months: MonthPoint[];
  recurringBills: RecurringBill[];
  safeToSpend: SafeToSpend;
  insights: Insight[];
  assumptions: string[];
};

export type TransactionList = {
  customerId: string;
  dataTimestamp: string;
  currency: "EUR";
  count: number;
  total: number;
  truncated: boolean;
  transactions: Transaction[];
};

// --- Financial futures ---

export type ScenarioBase = {
  balance: number;
  monthlyIncome: number;
  monthlySpending: number;
  monthlySaved: number; // deposits to investments the customer already makes
  monthlyMandatory: number;
  monthlyEveryday: number;
};

export type ScenarioInput = {
  billSavingPerMonth: number; // euros freed per month by any change: a cheaper contract, spending less on a category
  everydayCutPct: number; // 0..50, share of everyday spending trimmed
  years: number; // 1..10
  oneOffEur?: number; // optional: a lump sum (a gift, a bonus) that the "invest" branch moves into investments on day one
};

export type BranchId = "nothing" | "save" | "invest";

export type BranchPoint = { month: number; cash: number; invested: number; total: number; totalLow: number; totalHigh: number };

export type Branch = {
  id: BranchId;
  label: string;
  points: BranchPoint[];
  endTotal: number;
  endLow: number;
  endHigh: number;
  runwayMonthsAtYear1: number; // months of must-pay costs covered by cash alone after 12 months
};

export type ScenarioResult = {
  freedPerMonth: number;
  branches: Branch[];
  assumptions: string[];
};

// --- Agent, research and voice (lane C). See context/orchestration.md ---

export type BillType = "electricity" | "mobile" | "internet";

export type Citation = {
  title: string;
  url: string;
  retrievedAt: string; // ISO time we fetched it
  cacheAgeMs: number | null; // how old the provider's cached copy was, if it said
  readBy?: "context.dev" | "exa"; // which service read the page, when it was read for offers
};

export type Offer = {
  provider: string;
  plan: string | null;
  contractType: string | null; // e.g. fixed, spot
  contractMonths: number | null;
  monthlyPriceEur: number | null; // fixed monthly price or base fee
  energyPriceCentsPerKwh: number | null; // electricity only
  setupFeeEur: number | null;
  sourceUrl: string;
  comparable: boolean; // false when the price cannot be compared fairly (e.g. spot contracts)
  estimatedMonthlyCostEur: number | null; // computed in code
  estimatedYearlySavingEur: number | null; // computed in code, against the customer's current bill
};

export type ResearchStatus = "running" | "partial" | "done" | "failed";

export type ResearchResult = {
  key: string;
  billType: BillType;
  city: string;
  status: ResearchStatus;
  mock: boolean; // true = example data, not a live call. The UI must label it.
  query: string;
  startedAt: string;
  finishedAt: string | null;
  tookMs: number;
  pagesDone: number;
  pagesTotal: number;
  baselineMonthlyEur: number | null; // the customer's current bill, from the finance engine
  assumedYearlyKwh: number | null; // electricity only: the use the comparison is based on
  usageSource: "stated" | "estimated-from-bill" | "default" | null; // where that figure came from
  offers: Offer[];
  best: Offer | null;
  citations: Citation[];
  assumptions: string[];
  errors: string[];
};

export type ChatTurn = { role: "user" | "assistant"; content: string };

export type AgentRequest = {
  customerId: string;
  text: string;
  mode: "voice" | "text";
  history?: ChatTurn[];
  focusBill?: BillType; // the bill the user has open on screen, if any
  investigate?: boolean; // true = Sisu works through a whole investigation on its own (see POST /api/agent/investigate)
  language?: string; // ISO 639-1 code ("fi", "de", "hi") to answer in. Leave out to answer in whatever language the text is in
};

export type ToolTrace = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  source: "finance" | "exa+context.dev" | "exa";
  startedAtMs: number; // since the turn started
  tookMs: number;
  ok: boolean;
  summary: string; // one line a person can read
  joinedPrefetch: boolean; // true when research was already running or cached
};

export type TurnTimings = {
  sttMs: number | null;
  firstTokenMs: number | null; // since the turn started
  firstSentenceMs: number | null;
  totalMs: number;
  modelSteps: { model: string; provider: string; usedBackup: boolean; firstTokenMs: number | null; totalMs: number }[];
  retries?: string[]; // why Sisu made the model redo a step: "claimed-without-doing", "unsourced-number", ...
};

export type AgentEvent =
  | { type: "start"; turnId: string; provider: string; model: string; mock: boolean }
  | { type: "transcript"; text: string; tookMs: number; language?: string | null; languageProbability?: number | null } // language: what was spoken, ISO 639-1, when known
  | { type: "speculation"; billType: BillType; reason: string }
  | { type: "tool_start"; id: string; name: string; args: Record<string, unknown>; label?: string } // label: what Sisu is doing right now, in plain words, for the screen
  | { type: "tool_end"; trace: ToolTrace }
  | { type: "filler"; text: string }
  | { type: "research"; result: ResearchResult }
  | { type: "delta"; text: string }
  | { type: "sentence"; index: number; text: string }
  | { type: "done"; text: string; citations: Citation[]; timings: TurnTimings }
  | { type: "error"; message: string };

export type ApiError = { error: string };

// --- Receipts, investigation stages, teaching, actions and memory (added 14 Nov on overnight/fable-lead) ---
// Everything below is ADDITIVE: no existing type changed shape. See docs/FRONTEND_INTEGRATION_CONTRACT.md.

// Where a number came from. The UI can colour or label each figure by this.
export type SourceKind = "bank-data" | "exa" | "context.dev" | "assumption" | "customer-stated" | "calculation";

export type FactUnit = "EUR" | "EUR/month" | "EUR/year" | "kWh/year" | "c/kWh" | "months" | "count" | "percent" | "years" | "days";

// One receipt: a number Sisu is allowed to say, with where it came from and how to open the rows behind it.
export type Fact = {
  id: string;
  label: string;
  value: number;
  unit: FactUnit;
  source: SourceKind;
  basis: string; // one line a person can read: how it was worked out
  evidence?: EvidenceFilter; // pass to GET /api/customers/:id/transactions to show the rows
  url?: string; // for web facts
};

export type NumberCheck = {
  value: number; // the number as it appears in the final answer
  status: "receipt" | "context" | "trivial" | "unverified";
  factId: string | null; // set when status is "receipt"
};

// The model copied a figure almost right (a slipped digit). Sisu replaced it with the receipt's value before showing or speaking it.
export type NumberCorrection = { said: number; corrected: number; factId: string };

// Result of checking every number in the answer against the receipts. `ok` is false if any number has no source.
export type Grounding = { ok: boolean; checked: number; unverified: number[]; numbers: NumberCheck[]; corrections: NumberCorrection[]; nameCorrections?: { said: string; corrected: string }[] };

export type PatternKind = "bill-opportunity" | "bill-creep" | "overdraft-risk" | "payday-spike" | "category-drift" | "peer-gap" | "small-purchases" | "lumpy-costs" | "idle-cash";

// Something worth looking into, found by code in the customer's own history.
export type Pattern = {
  id: string;
  kind: PatternKind;
  title: string;
  detail: string;
  yearlyImpactEur: number | null; // null when no honest euro figure exists
  confidence: Confidence;
  billType: BillType | null; // set when live offer research can follow
  evidence: EvidenceFilter;
  facts: Fact[];
  nextSteps: string[]; // tool names that would take this further
};

export type PayCycle = { payday: string; income: number; lowestBalance: number; lowestOn: string; daysToLowest: number; spentInFirstWeek: number; spentInCycle: number };

export type CashFlow = {
  customerId: string;
  dataTimestamp: string;
  typicalPayday: number | null; // day of the month
  nextPayday: string | null; // first expected payday after the data ends
  daysToNextPayday: number | null;
  cycles: PayCycle[]; // most recent last
  averageDailyEverydayEur: number;
  billsDueBeforePayday: { billId: string; label: string; amount: number; expectedOn: string }[];
  projectedLowPointEur: number | null; // balance expected just before the next payday
  firstWeekShare: number | null; // share of a cycle's everyday spending that happens in the 7 days after payday
  negativeMonths: number;
  steps: CalcStep[];
  assumptions: string[];
};

// How much the customer could move to savings without running short, worked out from their own numbers.
export type SavingRoom = {
  nowEur: number; // a one-off amount that still leaves a week of everyday spending before payday
  perMonthEur: number; // what is left over in an average month
  cushionEur: number;
  steps: CalcStep[];
  basis: string;
};

export type AffordabilityVerdict = "comfortable" | "tight" | "not-yet";

export type Affordability = {
  amountEur: number;
  verdict: AffordabilityVerdict;
  balanceAfterEur: number;
  projectedLowPointEur: number | null;
  bufferMonthsAfter: number; // months of must-pay costs still covered by the balance afterwards
  monthsToSaveUp: number | null; // if not affordable now: months of current surplus needed
  steps: CalcStep[];
  assumptions: string[];
};

export type ConceptId = "three-baskets" | "safe-to-spend" | "fixed-vs-spot" | "buffer-first" | "compound-growth" | "switching-bills" | "pay-yourself-first";

// A teaching moment built from the customer's own numbers. Ask `question` BEFORE showing `reveal`.
export type TeachingCard = {
  id: string;
  concept: ConceptId;
  title: string;
  explanation: string;
  question: string;
  options: string[];
  correctIndex: number;
  reveal: string;
  facts: Fact[];
  revealVisual?: Visual; // a chart to show with the answer, once the customer has guessed
};

export type ActionKind = "switch_contract" | "standing_transfer" | "one_off_transfer";
export type ActionStatus = "awaiting_approval" | "executed_simulated" | "declined" | "expired";

export type ActionImpact = {
  monthlyEur: number;
  yearlyEur: number;
  horizonYears: number;
  branches: { id: BranchId; label: string; endTotal: number; endLow: number; endHigh: number }[];
  gainVsNothingEur: number; // "keep the cash" branch against "change nothing" at the horizon
  summary: string;
};

// A prepared action. Nothing happens until the user approves it, and even then it is a simulation.
export type AgentAction = {
  id: string;
  customerId: string;
  kind: ActionKind;
  status: ActionStatus;
  simulated: true;
  title: string;
  summary: string;
  checklist: string[]; // the steps a real switch would take
  draftMessage: string | null; // text Sisu drafted for the provider; never sent
  billType: BillType | null;
  offer: Offer | null;
  monthlyAmountEur: number;
  facts: Fact[];
  sources: Citation[];
  assumptions: string[];
  preparedBy: "sisu-agent" | "user";
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  impact: ActionImpact | null; // filled in when approved
  destination?: "savings" | "investments"; // transfers only: where the money goes, within the customer's own accounts
  warning?: string | null; // show this prominently: what going ahead would do, and the safer amount
  confirmation?: string | null; // filled in when approved: "Done (simulation). Reference SIM-1A2B3C4D."
};

export type AuditEventType = "action_prepared" | "action_approved" | "action_executed_simulated" | "action_declined" | "action_expired" | "memory_saved" | "memory_forgotten" | "consent_changed" | "demo_reset";

// Tamper-evident log: each event carries the hash of the one before it.
export type AuditEvent = {
  seq: number;
  at: string;
  customerId: string;
  type: AuditEventType;
  actor: "user" | "sisu-agent" | "system";
  actionId: string | null;
  detail: string;
  prevHash: string;
  hash: string;
};

export type MemoryKind = "bill_name" | "yearly_kwh" | "preference" | "goal";

export type MemoryItem = {
  id: string;
  kind: MemoryKind;
  key: string; // bill id for bill_name, otherwise a short label
  value: string;
  billType: BillType | null; // bill_name only: which kind of bill the user says it is
  source: "user-confirmed-in-app" | "user-said-in-chat";
  savedAt: string;
};

export type CustomerMemory = { customerId: string; consent: boolean; items: MemoryItem[] };

export type StageKind = "lead" | "evidence" | "research" | "extraction" | "calculation" | "teaching" | "action" | "impact" | "memory";

// One step of Sisu's work, typed so the UI can draw a card for it. A whole turn (or investigation) is a sequence of these.
export type Stage = {
  id: string;
  kind: StageKind;
  title: string;
  summary: string;
  source: SourceKind | "nemotron";
  toolCallId: string | null; // the tool call that produced it; matches ToolTrace.id
  atMs: number; // since the turn started
  facts: Fact[];
  data:
    | { kind: "lead"; patterns: Pattern[] }
    | { kind: "evidence"; filter: EvidenceFilter; count: number; totalEur: number; largest: { date: string; amount: number; category: string; merchantType: string | null }[] }
    | { kind: "research"; query: string; searchedWith: "exa"; pages: Citation[]; retrievedAt: string; mock: boolean }
    | { kind: "extraction"; extractedWith: "context.dev"; pagesRead: number; pagesTotal: number; offers: Offer[]; problems: string[] }
    | { kind: "calculation"; steps: CalcStep[]; resultLabel: string; resultValue: number; unit: FactUnit; assumptions: string[] }
    | { kind: "teaching"; card: TeachingCard }
    | { kind: "action"; action: AgentAction }
    | { kind: "impact"; impact: ActionImpact }
    | { kind: "memory"; item: MemoryItem };
};

// Extra events on the agent stream. Older clients can ignore them.
export type AgentExtraEvent =
  | { type: "stage"; stage: Stage }
  | { type: "action"; action: AgentAction } // show the approval card; approve with POST /api/actions/:id/approve
  | { type: "teaching"; card: TeachingCard }
  | { type: "memory"; item: MemoryItem }
  | { type: "grounding"; grounding: Grounding; facts: Fact[] } // sent just before "done"
  | { type: "visual"; visual: Visual } // a chart to draw with the answer (see Visual below, and app/visuals/)
  | { type: "replace"; text: string }; // the answer so far, after Sisu threw away a sentence that failed a check. Show this instead of the deltas received so far

export type SisuEvent = AgentEvent | AgentExtraEvent;

export type InvestigateRequest = { customerId: string; mode?: "voice" | "text"; focus?: PatternKind | BillType };

// approvedMonthlySavingEur: euros a month freed by approved switches, one switch per bill. Use it for the futures
// chart instead of adding the actions up on the client.
export type ActionList = { customerId: string; actions: AgentAction[]; audit: AuditEvent[]; auditChainValid: boolean; approvedMonthlySavingEur: number };

export type HealthReport = {
  ok: boolean;
  mock: boolean;
  model: { provider: string; name: string; host: string; region: string | null; reachable: boolean | null; latencyMs: number | null };
  backup: { provider: string; name: string; inUseNow: boolean } | null; // inUseNow: the main model failed recently, so the backup is answering
  services: { exa: boolean; contextDev: boolean; elevenLabs: boolean };
  dataBoundary: string[];
  store: { persistent: boolean; path: string | null; kind?: "file" | "supabase"; perVisitor?: boolean }; // kind and perVisitor: where state lives and whether each visitor has their own
  checkedAt: string;
};

// --- Reading a photographed bill with the model's vision (added 14 Nov) ---
// What Nemotron read from a photo of the customer's own bill. Nothing is saved until the user confirms it
// (POST /api/memory with kind "yearly_kwh"). Every field can be null: the model is told to leave out what it cannot see.
export type BillReading = {
  billType: BillType | null;
  provider: string | null;
  plan: string | null;
  contractType: string | null; // e.g. fixed, spot
  contractEndsOn: string | null; // YYYY-MM-DD
  yearlyKwh: number | null;
  energyPriceCentsPerKwh: number | null;
  monthlyFeeEur: number | null;
  billTotalEur: number | null;
  mock: boolean;
  readBy: { provider: string; model: string; tookMs: number };
  problems: string[]; // fields that were dropped because they were implausible or looked like instructions
};

export type BillPhotoResult = {
  customerId: string;
  reading: BillReading;
  facts: Fact[]; // the figures read, as receipts with source "customer-stated"
  comparison: ResearchResult | null; // today's offers compared using the bill's real kWh, if research is ready
  toConfirm: string; // the sentence to show the user before saving anything
};

// --- Mortgage application (added 14 Nov). From the S-Pankki mortgage files; only some customers have one. ---
export type MortgageApplication = {
  customerId: string;
  decision: string; // "approved" or "rejected"
  startedOn: string; // YYYY-MM-DD
  decidedOn: string | null;
  propertyType: string | null;
  propertyPriceEur: number;
  loanEur: number;
  ownMoneyEur: number; // the part the customer pays themselves
  collateralValueEur: number;
  loanToValuePct: number;
  requiredMonthlyIncomeEur: number;
  monthlyIncomeEur: number; // the customer's own 12-month average, from the bank data
  incomeMarginEur: number; // income minus what the application required
  balanceEur: number;
  ownMoneyStillNeededEur: number; // own money in the application minus the balance in this account, never below zero
  fees: { type: string; amountEur: number; on: string }[];
  timeline: { on: string; event: string }[];
  steps: CalcStep[];
  assumptions: string[];
};

// --- The money plan: Sisu goes through everything in one go and sets up what would save money (POST /api/agent/plan) ---

export type PlanItem = {
  id: string;
  kind: "switch" | "habit";
  title: string; // "Switch electricity to Vaasan Sähkö Myynti Oy"
  detail: string;
  yearlyEur: number;
  monthlyEur: number;
  // "nothing": saves money as it is (an electricity switch, priced at the customer's own use).
  // "check-plan": a cheaper internet or mobile plan. Sisu cannot see the speed or data the customer has now, so it
  // may be a smaller plan: it saves money only if it matches what they need.
  // "spending-change": a habit, which saves only if the spending really comes down.
  needs: "nothing" | "check-plan" | "spending-change";
  actionId: string | null; // the action set up for it, if one could be
  sources: Citation[];
  facts: Fact[];
};

export type PlanSearch = { billType: BillType; query: string; pagesRead: number; pagesFound: number; offersFound: number; tookMs: number; retrievedAt: string | null; live: boolean; mock: boolean };

// Something outside the account that the customer's own figures make worth checking, researched by Exa.
// `figuresConfirmed` is true when every number in the finding also appears in the excerpts taken from the pages.
export type PlanCheck = { id: string; title: string; query: string; ok: boolean; finding: string | null; figuresConfirmed: boolean; sources: Citation[]; yours: { label: string; value: number; unit: FactUnit } | null; tookMs: number; mock: boolean };

export type PlanProjection = { years: number; freedPerMonthEur: number; nothingEur: number; keptEur: number; investedEur: number; investedLowEur: number; investedHighEur: number; gainKeptEur: number; assumptions: string[] };

export type MoneyPlan = {
  id: string;
  customerId: string;
  createdAt: string;
  scanned: { transactions: number; months: number };
  items: PlanItem[];
  notices: { title: string; detail: string }[]; // worth knowing, with no honest euro figure
  checks: PlanCheck[]; // rules and prices outside the account, researched live, with sources
  actions: AgentAction[]; // set up and waiting for approval
  totalYearlyEur: number;
  effortlessYearlyEur: number; // the part that needs nothing from the customer
  checkPlanYearlyEur: number; // cheaper internet or mobile plans, if they match what the customer has now
  projection: PlanProjection | null;
  searches: PlanSearch[];
  summary: string;
  summaryBy: "nemotron" | "code"; // who worded the summary. Its numbers are checked either way
  facts: Fact[];
  tookMs: number; // real time on the server, start to finish
};

export type PlanEvent =
  | { type: "plan_start"; planId: string; customerName: string; provider: string; model: string; mock: boolean }
  | { type: "scan"; transactions: number; months: number; from: string; to: string; rows: { date: string; category: string; amount: number }[]; categories: { category: string; monthlyEur: number }[]; baskets: { id: BasketId; label: string; monthlyEur: number; sharePct: number }[]; tookMs: number }
  | { type: "finding"; id: string; role: "habit" | "bill" | "notice"; title: string; detail: string; yearlyEur: number | null }
  | { type: "search_start"; billType: BillType; query: string; engine: "exa" }
  | { type: "search_pages"; billType: BillType; pages: { url: string; host: string; title: string }[]; tookMs: number }
  | { type: "page_read"; billType: BillType; url: string; host: string; ok: boolean; offers: number; reader: "context.dev" | "exa"; ageMs: number | null; tookMs: number } // ageMs: how old the copy of the page was, when it was not read this second
  | { type: "offers"; billType: BillType; ok: boolean; best: Offer | null; yearlySavingEur: number | null; currentMonthlyEur: number | null; offersFound: number; live: boolean; note: string | null }
  | { type: "check_start"; id: string; title: string; query: string; engine: "exa" }
  | { type: "check_done"; check: PlanCheck }
  | { type: "calc"; steps: CalcStep[]; totalYearlyEur: number; effortlessYearlyEur: number; checkPlanYearlyEur: number }
  | { type: "action"; action: AgentAction }
  | { type: "projection"; projection: PlanProjection }
  | { type: "summary"; text: string; by: "nemotron" | "code"; tookMs: number }
  | { type: "plan_done"; plan: MoneyPlan }
  | { type: "error"; message: string };

// --- Pictures the agent puts on screen. Built in code; every number in one has a receipt in `facts`. ---

// `summary` says in a sentence or two what the picture shows, written by code: use it as alt text or a spoken line.
type VisualBase = { id: string; title: string; caption: string; summary: string; source: SourceKind; facts: Fact[] };

export type Visual = VisualBase &
  (
    | { kind: "budget_donut"; slices: { label: string; value: number; share: number }[]; total: number; centerLabel: string } // share is 0..100
    | { kind: "basket_bar"; total: number; baskets: { id: BasketId; label: string; description: string; monthly: number; share: number; top: { category: string; monthly: number }[] }[] } // share is 0..100
    | { kind: "peer_bars"; peerGroup: string; rows: { label: string; you: number; peers: number }[] }
    | { kind: "month_bars"; months: { month: string; label: string; income: number; spending: number }[] }
    | { kind: "waterfall"; steps: CalcStep[]; resultLabel: string; resultValue: number }
    | { kind: "futures_lines"; years: number; series: { id: BranchId; label: string; points: { year: number; value: number; low: number; high: number }[] }[] }
    | { kind: "offer_bars"; currentMonthlyEur: number; offers: { provider: string; plan: string | null; monthlyEur: number; yearlySavingEur: number; url: string }[]; mock: boolean }
  );

// What Sisu is doing right now, in one value, for a mascot or a status line. See lib/agent/activity.ts.
export type SisuActivityState = "idle" | "listening" | "thinking" | "reading_account" | "searching_web" | "reading_pages" | "calculating" | "found_something" | "setting_up" | "waiting_for_approval" | "speaking" | "approved" | "declined" | "error";
export type LiitoPose = "sleepy" | "curious" | "focused" | "gliding" | "found-something" | "cheering" | "proud" | "cosy";
export type SisuActivity = { state: SisuActivityState; liito: LiitoPose; label: string; detail: string | null };

// --- Demo readiness (added 14 Nov, afternoon): GET /api/health/ready ---
// Unlike /api/health, which says what is configured, every check here makes one real call to the service.
// status: "ok" answered correctly; "down" did not answer or answered wrongly; "not-configured" no key on this
// server; "mock" the server runs on example data, so nothing was called.
// blocksDemo: true when the flagship flow cannot run without it and nothing else stands in.
export type ReadinessId = "model" | "model-backup" | "exa" | "context-dev" | "elevenlabs" | "finance" | "store";
export type ReadinessCheck = { id: ReadinessId; sponsor: string; role: string; status: "ok" | "down" | "not-configured" | "mock"; latencyMs: number | null; detail: string; standIn: string | null; blocksDemo: boolean };
export type ReadinessReport = { ready: boolean; voiceReady: boolean; mock: boolean; headline: string; checks: ReadinessCheck[]; checkedAt: string; ageMs: number };
