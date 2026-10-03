jest.mock('../demoHttps', () => ({
  onReportCall: (_options:unknown,handler:unknown) => handler,
  onCall: (_options:unknown,handler:unknown) => handler,
  HttpsError: class extends Error { constructor(public code:string,message:string) { super(message); } },
}));
jest.mock('../cccAutomaticWorkflowMonitor', () => ({assertConsubancoSupervisorOrAdmin:jest.fn()}));
jest.mock('../agentActivity', () => ({buildAgentKey:(owner:string,agent:string)=>`${owner}__${agent}`}));
import { demoReportRange } from '../demoReports';

describe('manual demo report period contract', () => {
  it('resolves the synthetic completed week from ISO week', () => {
    expect(demoReportRange({reportType:'weekly',weekKey:'2026-W39'})).toMatchObject({startDate:'2026-09-21',endDate:'2026-09-27',timezone:'America/Mexico_City'});
  });
  it('preserves custom daily and weekly date ranges', () => {
    expect(demoReportRange({startDate:'2026-09-21',endDate:'2026-09-27',reportType:'weekly'}).endDate).toBe('2026-09-27');
    expect(demoReportRange({reportType:'daily',dateKey:'2026-09-21'}).startDate).toBe('2026-09-21');
  });
  it.each([{startDate:'2026-02-30'},{startDate:'2026-09-27',endDate:'2026-09-21'},{startDate:'2026-01-01',endDate:'2026-12-31'},{reportType:'weekly' as const,weekKey:'2026-W99'}])('rejects invalid periods %j', data => {
    expect(()=>demoReportRange(data)).toThrow();
  });
});
