import type { CallableRequest } from 'firebase-functions/v2/https';
import type { Firestore, DocumentData, DocumentReference, CollectionReference, DocumentSnapshot } from 'firebase-admin/firestore';
import { handleCancelCallProcessing } from '../cancelCallProcessing';
import { releaseDemoCallSlot, DEMO_BUDGET_PATH } from '../demoBudget';
import { markAutomaticRuntimeRetryComplete, requeueRuntimeFailure } from '../runtimeRetry';
import { DEMO_BUCKET, DEMO_PROJECT_ID } from '../demoConfig';
import { listAgentCoachingReportCalls } from '../agentCoachingReport';
import { cccAgentActivityVisibilityFields } from '../agentActivity';

jest.mock('firebase-admin', () => {
  const actual = jest.requireActual('firebase-admin');
  if (!actual.apps.length) actual.initializeApp({projectId:'kesp-demo-tonylai2789'});
  return actual;
});

/** Local document store only; no Admin credentials, emulator or provider requests. */
function fixture(call: Record<string, unknown>, activeCalls: Record<string, number>) {
  const values = new Map<string, DocumentData>([
    ['calls/a', call],
    [DEMO_BUDGET_PATH, { enabled:true, limitMicros:25_000_000, spentMicros:0, reservedMicros:0, activeCalls }],
  ]);
  const ref = (path: string): DocumentReference => ({
    path, id:path.split('/').pop(), firestore:db,
    get:async () => ({ exists:values.has(path), data:() => values.get(path) }),
    update:async (fields:Record<string,unknown>) => { values.set(path,{...values.get(path),...fields}); },
    collection:(name:string) => collection(path+'/'+name),
  } as unknown as DocumentReference);
  const collection = (path:string): CollectionReference => ({ doc:(id:string) => ref(path+'/'+id), get:async () => ({docs:[],empty:true}) } as unknown as CollectionReference);
  const db = {
    doc:ref, collection,
    runTransaction:async (fn:(transaction:{get:(reference:DocumentReference)=>Promise<DocumentSnapshot>;update:(reference:DocumentReference,fields:DocumentData)=>Promise<unknown>})=>Promise<unknown>) => fn({
      get:(reference:DocumentReference)=>reference.get(), update:(reference:DocumentReference,fields:DocumentData)=>reference.update(fields),
    }),
  } as unknown as Firestore;
  return { db:db as Firestore, values, callRef:ref('calls/a') };
}

beforeEach(() => {
  process.env.GCLOUD_PROJECT = DEMO_PROJECT_ID;
  delete process.env.GOOGLE_CLOUD_PROJECT;
  delete process.env.GCP_PROJECT;
  delete process.env.FIREBASE_CONFIG;
});

describe('demo integration lifecycle regressions', () => {
  it('releases the admitted generation when actual cancellation increments the call generation', async () => {
    const f = fixture({ uploadedBy:'tony', status:'analyzing', processingGeneration:0 }, {a:0});
    await handleCancelCallProcessing({auth:{uid:'tony'},data:{callId:'a'}} as CallableRequest<{callId:string}>, f.db);
    const terminal = f.values.get('calls/a')!;
    expect(terminal.processingGeneration).toBe(1);
    // Matches the terminal branch of onStartAnalyzing, not a hand-invented release generation.
    await releaseDemoCallSlot('a', terminal.processingGeneration, f.db);
    expect(f.values.get(DEMO_BUDGET_PATH)!.activeCalls).toEqual({});
  });

  it('does not mark a newer retry complete from an old completed event', async () => {
    const f = fixture({status:'analyzing',processingGeneration:2,automaticRetryState:'running'}, {a:2});
    await markAutomaticRuntimeRetryComplete(f.callRef, {status:'complete',processingGeneration:1,automaticRetryState:'running'});
    expect(f.values.get('calls/a')!.automaticRetryState).toBe('running');
  });

  it('leaves failed calls unchanged when the two processing slots are occupied', async () => {
    const f = fixture({status:'error',processingGeneration:0,organizationId:'consubanco',visibilityScope:'organization',
      callSource:'manual_upload',preparedUploadRequestId:'a',audioStorageBucket:DEMO_BUCKET,
      automaticRetryState:'eligible',automaticRetryStage:'analysis',errorSource:'analysis_task',
      lastFailedRuntimeError:{errorSource:'analysis_task',message:'failure',retryable:true}}, {b:0,c:0});
    expect(await requeueRuntimeFailure({callRef:f.callRef,source:'manual_admin'})).toMatchObject({queued:false,skippedReason:'demo_concurrency_limit'});
    expect(f.values.get('calls/a')!.status).toBe('error');
    expect(f.values.get('calls/a')!.processingGeneration).toBe(0);
  });

});

/** Synthetic query store covers real report loader predicates without external reads. */
function reportFixture() {
  const values = new Map<string, DocumentData>();
  const snapshot = (path:string) => ({id:path.split('/').pop(),exists:values.has(path),data:()=>values.get(path)});
  const doc = (path:string):DocumentReference => ({get:async()=>snapshot(path),collection:(name:string)=>query(path+'/'+name)} as unknown as DocumentReference);
  const query = (path:string, filters:Array<(key:string,data:DocumentData)=>boolean>=[], limit=Infinity):CollectionReference => ({
    doc:(id:string)=>doc(path+'/'+id),
    where:(field:unknown,operator:string,value:unknown)=>query(path,[...filters,(key,data)=>{
      const actual = typeof field === 'string' ? data[field] : key.split('/').pop();
      return operator === 'in' ? Array.isArray(value) && value.includes(actual) : operator === '==' ? actual === value : operator === '>=' ? String(actual) >= String(value) : String(actual) <= String(value);
    }],limit),
    limit:(next:number)=>query(path,filters,next),
    get:async()=>({docs:[...values.keys()].filter(key=>key.startsWith(path+'/') && key.split('/').length === path.split('/').length+1 &&
      filters.every(filter=>filter(key,values.get(key)!))).slice(0,limit).map(snapshot)}),
  } as unknown as CollectionReference);
  for (const [id,owner] of [['a','tony'],['b','logi']]) {
    values.set('calls/'+id,{uploadedBy:owner,salesAgentId:'agent_demo',status:'complete',organizationId:'consubanco',visibilityScope:'organization',
      callSource:'manual_upload',preparedUploadRequestId:id,audioStorageBucket:DEMO_BUCKET,duration:120,latestFeedbackId:'final'});
    values.set('calls/'+id+'/feedback/final',{summary:'Synthetic feedback'});
    values.set('agent_activity/'+owner+'__agent_demo',{uploadedBy:owner,salesAgentId:'agent_demo'});
    values.set('agent_activity/'+owner+'__agent_demo/call_snapshots/'+id,{sourceCallId:id,uploadedBy:owner,salesAgentId:'agent_demo',
      latestFeedbackId:'final',bucketDay:'2026-09-21',overallScore:80});
  }
  const db = {collection:query} as unknown as Firestore;
  const list = () => listAgentCoachingReportCalls(db,{agentAnalysisId:'demo',uploadedBy:'tony',salesAgentId:'agent_demo',
    salesAgentName:'Fictional Agent',agentKey:'tony__agent_demo'},
  {startDate:'2026-09-21',endDate:'2026-09-27',timezone:'America/Mexico_City',label:'Demo week'});
  return {values,list};
}

describe('shared manual report and activity selection', () => {
  it('includes both uploaders for the same shared agent and does not duplicate the profile root', async () => {
    expect((await reportFixture().list()).map(row=>row.callId).sort()).toEqual(['a','b']);
  });
  it.each([
    {salesAgentId:'other_agent'}, {status:'error'}, {analysisPipeline:'manual_short_call_review'},
    {latestFeedbackId:'new-final'}, {callSource:'ccc_gcs'}, {agentProfileExcluded:true},
  ])('ignores stale or ineligible call snapshots: %j', async changes => {
    const f = reportFixture(); Object.assign(f.values.get('calls/b')!,changes);
    expect((await f.list()).map(row=>row.callId)).toEqual(['a']);
  });
  it('requires a real final feedback document', async () => {
    const f = reportFixture(); f.values.delete('calls/b/feedback/final');
    expect((await f.list()).map(row=>row.callId)).toEqual(['a']);
  });
  it('retains date scoping across all uploaders', async () => {
    const f = reportFixture(); f.values.get('agent_activity/logi__agent_demo/call_snapshots/b')!.bucketDay='2026-09-28';
    expect((await f.list()).map(row=>row.callId)).toEqual(['a']);
  });
  it('shares only real prepared demo activity while preserving manual provenance', () => {
    const call = reportFixture().values.get('calls/a')!;
    expect(cccAgentActivityVisibilityFields(call)).toMatchObject({organizationId:'consubanco',visibilityScope:'organization',activitySource:'manual_upload'});
    expect(cccAgentActivityVisibilityFields({...call,preparedUploadRequestId:undefined})).toEqual({});
  });
});
