import * as admin from 'firebase-admin';
import { collectAgentAnalysisInputState } from '../agentAnalyses';
import { DEMO_BUCKET } from '../demoConfig';

jest.mock('../demoPaidProviders',()=>({createDemoOpenAI:jest.fn(()=>{throw new Error('No paid requests in input tests');})}));
jest.mock('../kespInbox',()=>({createKespInboxMessageWithId:jest.fn()}));
jest.mock('../processingTaskQueue',()=>({enqueueAgentAnalysisTask:jest.fn()}));
jest.mock('firebase-admin',()=>{
  const actual=jest.requireActual('firebase-admin');
  const values=new Map<string,FirebaseFirestore.DocumentData>();
  const queries:Array<Array<[string,string,unknown]>>=[];
  const doc=(key:string):FirebaseFirestore.DocumentReference=>({
    get:async()=>({exists:values.has(key),data:()=>values.get(key)}),
    collection:(name:string)=>query(key+'/'+name),
  } as unknown as FirebaseFirestore.DocumentReference);
  const query=(path:string,filters:Array<[string,string,unknown]>=[]):FirebaseFirestore.CollectionReference=>({
    doc:(id:string)=>doc(path+'/'+id),
    where:(field:string,op:string,value:unknown)=>query(path,[...filters,[field,op,value]]),
    orderBy:()=>query(path,filters),
    get:async()=>{
      queries.push(filters);
      return {docs:[...values.keys()].filter(key=>key.startsWith(path+'/') && key.split('/').length===path.split('/').length+1 &&
        filters.every(([field,,value])=>values.get(key)?.[field]===value)).map(key=>({id:key.split('/').pop(),ref:doc(key),data:()=>values.get(key)}))};
    },
  } as unknown as FirebaseFirestore.CollectionReference);
  return {...actual,__testValues:values,__testQueries:queries,firestore:Object.assign(()=>({collection:query}),actual.firestore)};
});

const state=admin as unknown as {__testValues:Map<string,FirebaseFirestore.DocumentData>;__testQueries:Array<Array<[string,string,unknown]>>};
beforeEach(()=>{
  state.__testValues.clear();state.__testQueries.length=0;
  for(const [id,uploadedBy] of [['a','tony'],['b','logi']]) {
    state.__testValues.set('calls/'+id,{uploadedBy,salesAgentId:'agent_demo',status:'complete',organizationId:'consubanco',
      visibilityScope:'organization',callSource:'manual_upload',audioStorageBucket:DEMO_BUCKET,preparedUploadRequestId:id,
      latestFeedbackId:'final',duration:120,createdAt:new Date('2026-09-21T18:00:00Z')});
    state.__testValues.set('calls/'+id+'/feedback/final',{rubric_scorecard_v2:{rubric_version:'subagent_2.0_v6_3',sections:[]}});
  }
});

describe('shared demo pattern-analysis inputs',()=>{
  const collect=()=>collectAgentAnalysisInputState('tony','agent_demo',undefined,{agentAnalysisId:'demo'});
  it('includes final analyzed calls from both uploaders with an exact manual organization query',async()=>{
    const result=await collect();
    expect(result.eligibleCallIds.sort()).toEqual(['a','b']);
    expect(result.sourceCallIds.sort()).toEqual(['a','b']);
    expect(state.__testQueries[0]).toEqual([
      ['organizationId','==','consubanco'],['visibilityScope','==','organization'],['callSource','==','manual_upload'],
      ['salesAgentId','==','agent_demo'],['status','==','complete'],
    ]);
    expect(result.environmentTarget).toBeUndefined();
  });
  it.each([
    {organizationId:'other'},{visibilityScope:'private'},{callSource:'ccc_gcs'},{salesAgentId:'other_agent'},{status:'error'},
    {preparedUploadRequestId:undefined},{audioStorageBucket:'other-bucket'},{analysisPipeline:'manual_short_call_review'},
    {agentProfileExcluded:true},{transcriptionComparison:true},{latestFeedbackId:undefined},
  ])('rejects unsafe or ineligible candidate %j',async changes=>{
    Object.assign(state.__testValues.get('calls/b')!,changes);
    expect((await collect()).eligibleCallIds).toEqual(['a']);
  });
  it('still requires a real final-feedback document and supported analysis schema',async()=>{
    state.__testValues.delete('calls/b/feedback/final');
    expect(await collect()).toMatchObject({eligibleCallIds:['a'],skipReasons:{missing_feedback_doc:1}});
    state.__testValues.set('calls/b/feedback/final',{rubric_scorecard_v2:{rubric_version:'unsupported'}});
    expect(await collect()).toMatchObject({eligibleCallIds:['a'],skipReasons:{unsupported_feedback_version:1}});
  });
});
