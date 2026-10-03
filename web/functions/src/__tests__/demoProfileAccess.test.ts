import * as admin from 'firebase-admin';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { canAccessDemoProfileResource } from '../demoProfileAccess';
import { handleStartAgentAnalysis } from '../startAgentAnalysis';
import { handleGetAgentProfileAssistantChat, handleResetAgentProfileAssistantChat, buildAgentProfileAssistantChatId } from '../agentProfileAssistant';
import { refreshAgentActivity } from '../refreshAgentActivity';
import { updateAgentReminder } from '../updateAgentReminder';
import { setLoanCaseStage } from '../setLoanCaseStage';
import { updateAgentReminderByUser, setLoanCaseStageByUser, syncAgentActivityForCall } from '../agentActivity';

jest.mock('../demoHttps', () => ({
  onPaidCall:(optionsOrHandler:unknown,handler:unknown)=>handler ?? optionsOrHandler,
  onCall:(optionsOrHandler:unknown,handler:unknown)=>handler ?? optionsOrHandler,
  HttpsError:jest.requireActual('firebase-functions/v2/https').HttpsError,
}));
jest.mock('../agentAnalyses', () => ({
  collectAgentAnalysisInputState:jest.fn(async()=>({sourceCallIds:['a'],eligibleCallIds:['a'],inputFingerprint:'synthetic'})),
  normalizeAgentAnalysisProcessingConfig:()=>({}), resolveAgentAnalysisEnvironmentTarget:()=>undefined,
}));
jest.mock('../agentDuplicateCalls', () => ({reconcileAgentProfileDuplicates:jest.fn()}));
jest.mock('../kespInbox', () => ({createKespInboxMessage:jest.fn()}));
jest.mock('../agentActivity', () => ({
  updateAgentReminderByUser:jest.fn(), setLoanCaseStageByUser:jest.fn(),
  syncAgentActivityForCall:jest.fn(async()=>({updated:true})), cleanupAgentActivityForExcludedCall:jest.fn(),
}));
jest.mock('../demoPaidProviders', () => ({createDemoOpenAI:jest.fn(()=>{throw new Error('No paid calls in access tests');})}));
jest.mock('firebase-admin', () => {
  const actual = jest.requireActual('firebase-admin');
  const values = new Map<string,FirebaseFirestore.DocumentData>();
  const snapshot = (path:string) => ({id:path.split('/').pop(),exists:values.has(path),data:()=>values.get(path)});
  const doc = (path:string):FirebaseFirestore.DocumentReference => ({
    get:async()=>snapshot(path),
    set:async(data:FirebaseFirestore.DocumentData)=>{values.set(path,{...values.get(path),...data});},
    update:async(data:FirebaseFirestore.DocumentData)=>{values.set(path,{...values.get(path),...data});},
    collection:(name:string)=>collection(path+'/'+name),
  } as unknown as FirebaseFirestore.DocumentReference);
  const collection = (path:string,filters:Array<[string,unknown]>=[]):FirebaseFirestore.CollectionReference => ({
    doc:(id:string)=>doc(path+'/'+id), where:(field:string,_op:string,value:unknown)=>collection(path,[...filters,[field,value]]),
    get:async()=>({docs:[...values.keys()].filter(key=>key.startsWith(path+'/') && key.split('/').length===path.split('/').length+1 &&
      filters.every(([field,value])=>values.get(key)?.[field]===value)).map(snapshot)}),
  } as unknown as FirebaseFirestore.CollectionReference);
  const db = {doc,collection,runTransaction:async(fn:(transaction:unknown)=>Promise<unknown>)=>fn({
    get:(ref:FirebaseFirestore.DocumentReference)=>ref.get(),update:(ref:FirebaseFirestore.DocumentReference,data:FirebaseFirestore.DocumentData)=>ref.update(data),
  })};
  return {...actual,__testValues:values,firestore:Object.assign(()=>db,actual.firestore),auth:()=>({
    getUser:async(uid:string)=>values.get('auth/'+uid),
  })};
});

const values = (admin as unknown as {__testValues:Map<string,FirebaseFirestore.DocumentData>}).__testValues;
const shared = {uploadedBy:'tony',salesAgentId:'agent_demo',organizationId:'consubanco',visibilityScope:'organization',salesAgentName:'Fictional'};
const request = (data:Record<string,unknown>,uid='logi') => ({auth:{uid},data}) as CallableRequest<Record<string,unknown>>;
const invoke = (handler:unknown,data:Record<string,unknown>,uid='logi') =>
  (handler as (request:CallableRequest<Record<string,unknown>>)=>Promise<unknown>)(request(data,uid));

beforeEach(()=>{
  jest.clearAllMocks(); values.clear();
  for (const [uid,email,role] of [['tony','tonylai2789@gmail.com','admin'],['logi','logitech2789@gmail.com','supervisor']]) {
    values.set('auth/'+uid,{uid,email,emailVerified:true,disabled:false,providerData:[{providerId:'google.com',email}]});
    values.set('organizations/consubanco/members/'+uid,{uid,email,organizationId:'consubanco',role});
  }
  values.set('config/allowedEmails',{emails:['tonylai2789@gmail.com','logitech2789@gmail.com']});
  values.set('agent_analyses/demo',{...shared,status:'ready'});
  values.set('agent_activity/tony__agent_demo',{...shared,activitySource:'manual_upload'});
  values.set('calls/a',{uploadedBy:'tony',salesAgentId:'agent_demo',status:'complete'});
});

describe('demo shared supervisor controls',()=>{
  it('requires exact shared namespace or a legacy privately owned resource, never a CCC flag',()=>{
    expect(canAccessDemoProfileResource('logi',shared)).toBe(true);
    expect(canAccessDemoProfileResource('logi',{uploadedBy:'tony',salesAgentId:'agent_demo',isCccCanonicalProfile:true})).toBe(false);
    for (const data of [{...shared,organizationId:'other'},{...shared,visibilityScope:'public'},{...shared,uploadedBy:''},undefined]) {
      expect(canAccessDemoProfileResource('logi',data)).toBe(false);
    }
  });
  it('lets the supervisor start analysis on the shared seeded profile',async()=>{
    expect(await handleStartAgentAnalysis(request({agentAnalysisId:'demo'}) as CallableRequest<{agentAnalysisId:string}>,admin.firestore()))
      .toMatchObject({started:true,result:'started'});
    expect(values.get('agent_analyses/demo')!.status).toBe('analyzing');
  });
  it('lets the supervisor refresh activity and records the real actor for reminder/stage edits',async()=>{
    expect(await invoke(refreshAgentActivity,{agentAnalysisId:'demo'})).toMatchObject({processedCount:1});
    expect(syncAgentActivityForCall).toHaveBeenCalled();
    await invoke(updateAgentReminder,{agentKey:'tony__agent_demo',reminderId:'r',state:'done'});
    expect(updateAgentReminderByUser).toHaveBeenCalledWith(expect.objectContaining({userId:'logi',agentKey:'tony__agent_demo',reminderId:'r'}));
    await invoke(setLoanCaseStage,{agentKey:'tony__agent_demo',caseId:'c',stage:'fully_completed'});
    expect(setLoanCaseStageByUser).toHaveBeenCalledWith(expect.objectContaining({userId:'logi',agentKey:'tony__agent_demo',caseId:'c'}));
  });
  it('shares profile context but keeps assistant chats and resets owned by the caller',async()=>{
    const tonyKey=buildAgentProfileAssistantChatId('tony','demo');
    const logiKey=buildAgentProfileAssistantChatId('logi','demo');
    values.set('agent_profile_assistant_chats/'+tonyKey,{userId:'tony',agentAnalysisId:'demo',secret:'owner-only'});
    const req=request({agentAnalysisId:'demo'}) as CallableRequest<{agentAnalysisId:string}>;
    expect(await handleGetAgentProfileAssistantChat(req,admin.firestore())).toMatchObject({success:true,chat:{userId:'logi'}});
    await handleResetAgentProfileAssistantChat(req,admin.firestore());
    expect(values.get('agent_profile_assistant_chats/'+tonyKey)!.secret).toBe('owner-only');
    values.set('agent_profile_assistant_chats/'+logiKey,{userId:'tony',agentAnalysisId:'demo'});
    await expect(handleGetAgentProfileAssistantChat(req,admin.firestore())).rejects.toMatchObject({code:'permission-denied'});
  });
  it.each(['disabled','revoked','agent','identity'])('rejects %s staff across all five actions before effects',async condition=>{
    if(condition==='disabled') values.get('auth/logi')!.disabled=true;
    if(condition==='revoked') values.set('config/allowedEmails',{emails:['tonylai2789@gmail.com']});
    if(condition==='agent') values.get('organizations/consubanco/members/logi')!.role='agent';
    if(condition==='identity') values.get('organizations/consubanco/members/logi')!.email='forged@example.com';
    for(const [handler,data] of [
      [refreshAgentActivity,{agentAnalysisId:'demo'}], [updateAgentReminder,{agentKey:'tony__agent_demo',reminderId:'r'}],
      [setLoanCaseStage,{agentKey:'tony__agent_demo',caseId:'c',stage:'fully_completed'}],
    ] as const) await expect(invoke(handler,data)).rejects.toMatchObject({code:'permission-denied'});
    const req=request({agentAnalysisId:'demo'}) as CallableRequest<{agentAnalysisId:string}>;
    await expect(handleStartAgentAnalysis(req,admin.firestore())).rejects.toMatchObject({code:'permission-denied'});
    await expect(handleGetAgentProfileAssistantChat(req,admin.firestore())).rejects.toMatchObject({code:'permission-denied'});
    expect(updateAgentReminderByUser).not.toHaveBeenCalled();
    expect(setLoanCaseStageByUser).not.toHaveBeenCalled();
    expect(syncAgentActivityForCall).not.toHaveBeenCalled();
  });
  it('rejects another owner private profile/activity even for approved staff',async()=>{
    values.set('agent_analyses/demo',{uploadedBy:'tony',salesAgentId:'agent_demo'});
    values.set('agent_activity/tony__agent_demo',{uploadedBy:'tony',salesAgentId:'agent_demo'});
    await expect(invoke(refreshAgentActivity,{agentAnalysisId:'demo'})).rejects.toMatchObject({code:'permission-denied'});
    await expect(invoke(updateAgentReminder,{agentKey:'tony__agent_demo',reminderId:'r'})).rejects.toMatchObject({code:'permission-denied'});
  });
});
