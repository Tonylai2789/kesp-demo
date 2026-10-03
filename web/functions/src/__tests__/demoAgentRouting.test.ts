import { DEMO_BUCKET } from "../demoConfig";
import { readDemoMember } from "../demoAccess";
import { assertDemoRuntime } from "../demoBudget";
import {
  ACTIVE_CALL_AGENTS, ACTIVE_CALL_AGENT_NAMES, matchActiveAgentName,
} from "../activeCallAgents";

const mockRecords = new Map<string, Record<string, unknown>>();
const mockWrites = jest.fn();
const mockCollections = jest.fn();
const mockWhere = jest.fn();
const mockDb = {
  collection: (name: string) => {
    mockCollections(name);
    const filters: Array<[string, unknown]> = [];
    const query = {
      where: (key: string, _operator: string, value: unknown) => {
        mockWhere(key, value); filters.push([key, value]); return query;
      },
      get: async () => ({
        docs: [...mockRecords].filter(([path, data]) =>
          path.startsWith(name + "/") && filters.every(([key, value]) => data[key] === value))
          .map(([path, data]) => ({ id: path.split("/")[1], data: () => ({ ...data }) })),
      }),
      doc: (id: string) => ({
        get: async () => ({
          exists: mockRecords.has(name + "/" + id),
          data: () => ({ ...mockRecords.get(name + "/" + id) }),
        }),
        update: async (data: Record<string, unknown>) => {
          mockWrites(name + "/" + id, data);
          mockRecords.set(name + "/" + id, { ...mockRecords.get(name + "/" + id), ...data });
        },
      }),
    };
    return query;
  },
};
jest.mock("firebase-admin", () => ({
  firestore: () => mockDb,
  apps: [{ options: { projectId: "kesp-demo-tonylai2789" } }],
  app: () => ({ options: { projectId: "kesp-demo-tonylai2789" } }),
}));
jest.mock("../demoAccess", () => ({
  ...jest.requireActual("../demoAccess"), readDemoMember: jest.fn(),
}));
jest.mock("../demoBudget", () => ({ assertDemoRuntime: jest.fn() }));
jest.mock("../agentActivity", () => ({
  buildAgentKey: jest.fn(), syncAgentActivityForCall: jest.fn(),
}));
jest.mock("../agentDuplicateCalls", () => ({
  buildDuplicateFingerprintKeys: jest.fn(() => []), reconcileAgentProfileDuplicates: jest.fn(),
}));

import {
  ensureActiveAgentProfilesForOwner, routeGeneralAgentCallAfterFeedback,
  assignGeneralAgentCallToAgent,
} from "../agentRouting";

const profile = {
  uploadedBy: "demo-admin", salesAgentId: "demo_lucia_modelo", salesAgentName: "Lucía Modelo",
  organizationId: "consubanco", visibilityScope: "organization", isActiveAgentProfile: true,
};
const call = {
  uploadedBy: "demo-admin", organizationId: "consubanco", visibilityScope: "organization",
  callSource: "manual_upload", preparedUploadRequestId: "prepared-demo", audioStorageBucket: DEMO_BUCKET,
  agentRoutingMode: "general", agentRoutingStatus: "unrecognized",
};

beforeEach(() => {
  jest.clearAllMocks(); mockRecords.clear();
  jest.mocked(readDemoMember).mockResolvedValue({ role: "supervisor" });
  jest.mocked(assertDemoRuntime).mockImplementation(() => undefined);
  mockRecords.set("agent_analyses/demo_lucia_modelo", { ...profile });
  mockRecords.set("calls/demo-call", { ...call });
});

test("contains no preset roster and never matches a name without supplied profiles", () => {
  expect(ACTIVE_CALL_AGENT_NAMES).toEqual([]);
  expect(ACTIVE_CALL_AGENTS).toEqual([]);
  expect(matchActiveAgentName("Lucía Modelo").status).toBe("unrecognized");
});

test("compatibility seeder returns only existing shared profiles without creating/adopting anything", async () => {
  mockRecords.set("agent_analyses/private", { ...profile, visibilityScope: "private" });
  mockRecords.set("agent_analyses/other-org", { ...profile, organizationId: "other" });
  const result = await ensureActiveAgentProfilesForOwner("demo-supervisor");
  expect(result).toMatchObject({ createdCount: 0, adoptedCount: 0, unchangedCount: 1 });
  expect(result.profiles.map(p => p.agentAnalysisId)).toEqual(["demo_lucia_modelo"]);
  expect(mockWrites).not.toHaveBeenCalled();
  expect(mockCollections.mock.calls.every(([name]) => name === "agent_analyses")).toBe(true);
});

test("empty shared profile store remains empty, even when general matching runs", async () => {
  mockRecords.delete("agent_analyses/demo_lucia_modelo");
  expect((await ensureActiveAgentProfilesForOwner("demo-admin")).profiles).toEqual([]);
  const result = await routeGeneralAgentCallAfterFeedback({
    callId: "demo-call", callData: call, feedback: { agent_name: "Lucía Modelo" },
  });
  expect(result.routingStatus).toBe("unrecognized");
  expect(mockWrites).not.toHaveBeenCalled();
});

test("general matching uses existing shared profile name and exact real profile IDs without mapping", async () => {
  const result = await routeGeneralAgentCallAfterFeedback({
    callId: "demo-call", callData: call, feedback: { agent_name: "LUCIA MODELO" },
  });
  expect(result.materializedCallFields).toMatchObject({
    salesAgentId: "demo_lucia_modelo", matchedAgentAnalysisId: "demo_lucia_modelo",
    agentRoutingStatus: "matched",
  });
  expect(Object.keys(result.callUpdate).some(key => key.startsWith("ccc"))).toBe(false);
  expect(mockCollections.mock.calls.flat()).not.toContain("ccc_agent_mappings");
  expect(mockWrites).not.toHaveBeenCalled();
});

test("ambiguous duplicate names remain unrecognized", async () => {
  mockRecords.set("agent_analyses/another-demo", { ...profile, salesAgentId: "another-demo" });
  const result = await routeGeneralAgentCallAfterFeedback({
    callId: "demo-call", callData: call, feedback: { agent_name: "Lucía Modelo" },
  });
  expect(result.routingStatus).toBe("unrecognized");
  expect(result.materializedCallFields.agentRoutingReason).toBe("ambiguous_active_agent_match");
});

test.each(["demo-admin", "demo-supervisor"])("staff %s assigns shared call without any CCC mapping", async userId => {
  const result = await assignGeneralAgentCallToAgent({
    userId, callId: "demo-call", agentAnalysisId: "demo_lucia_modelo",
  });
  expect(result).toMatchObject({ success: true, changed: true, agentAnalysisId: "demo_lucia_modelo" });
  const updated = mockRecords.get("calls/demo-call");
  expect(updated).toMatchObject({
    uploadedBy: "demo-admin", salesAgentId: "demo_lucia_modelo",
    matchedAgentAnalysisId: "demo_lucia_modelo", assignedBy: userId,
    agentRoutingStatus: "manually_assigned",
  });
  expect(Object.keys(updated!).some(key => key.startsWith("ccc"))).toBe(false);
  expect(mockCollections.mock.calls.flat()).not.toContain("ccc_agent_mappings");
  expect(mockWrites).toHaveBeenCalledTimes(1);
});

test.each([
  { visibilityScope: "private" }, { organizationId: "other" },
  { audioStorageBucket: "unrelated-bucket" }, { preparedUploadRequestId: undefined },
])("rejects calls outside shared prepared demo scope: %j", async change => {
  mockRecords.set("calls/demo-call", { ...call, ...change });
  await expect(assignGeneralAgentCallToAgent({
    userId: "demo-supervisor", callId: "demo-call", agentAnalysisId: "demo_lucia_modelo",
  })).rejects.toMatchObject({ code: "permission-denied" });
  expect(mockWrites).not.toHaveBeenCalled();
});

test.each([
  { visibilityScope: "private" }, { organizationId: "other" }, { salesAgentId: "" },
  { isActiveAgentProfile: false },
])("rejects inaccessible or invalid profile: %j", async change => {
  mockRecords.set("agent_analyses/demo_lucia_modelo", { ...profile, ...change });
  await expect(assignGeneralAgentCallToAgent({
    userId: "demo-admin", callId: "demo-call", agentAnalysisId: "demo_lucia_modelo",
  })).rejects.toMatchObject({ code: "permission-denied" });
  expect(mockWrites).not.toHaveBeenCalled();
});

test.each([null, { role: "agent" }])("rejects non-staff membership: %j", async member => {
  jest.mocked(readDemoMember).mockResolvedValue(member);
  await expect(ensureActiveAgentProfilesForOwner("demo-admin")).rejects.toMatchObject({ code: "permission-denied" });
  await expect(assignGeneralAgentCallToAgent({
    userId: "demo-admin", callId: "demo-call", agentAnalysisId: "demo_lucia_modelo",
  })).rejects.toMatchObject({ code: "permission-denied" });
  expect(mockWrites).not.toHaveBeenCalled();
});

test("fails closed on runtime identity or live authorization failure", async () => {
  jest.mocked(assertDemoRuntime).mockImplementation(() => { throw new Error("wrong project"); });
  await expect(ensureActiveAgentProfilesForOwner("demo-admin")).rejects.toThrow("wrong project");
  jest.mocked(assertDemoRuntime).mockImplementation(() => undefined);
  jest.mocked(readDemoMember).mockRejectedValue(new Error("disabled Google account"));
  await expect(ensureActiveAgentProfilesForOwner("demo-admin")).rejects.toThrow("disabled Google account");
  expect(mockCollections).not.toHaveBeenCalled();
});

test("does not overwrite a call already linked to another profile", async () => {
  mockRecords.set("calls/demo-call", { ...call, salesAgentId: "another-demo" });
  await expect(assignGeneralAgentCallToAgent({
    userId: "demo-admin", callId: "demo-call", agentAnalysisId: "demo_lucia_modelo",
  })).rejects.toMatchObject({ code: "failed-precondition" });
  expect(mockWrites).not.toHaveBeenCalled();
});
