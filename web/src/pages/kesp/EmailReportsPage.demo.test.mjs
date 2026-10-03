import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18next from 'i18next';
import ts from 'typescript';
import { previousDemoWeek } from '../../lib/demoReportPeriod.ts';
import * as redaction from '../../lib/kespDemoRedaction.ts';
const require = createRequire(import.meta.url);
const source = ts.transpileModule(readFileSync(new URL('./EmailReportsPage.tsx', import.meta.url),'utf8'), { compilerOptions: { module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022, jsx:ts.JsxEmit.ReactJSX } }).outputText;

function render(authorized, language) {
  const locale = i18next.createInstance();
  locale.init({ lng:language, initImmediate:false, resources: { [language]: { translation:JSON.parse(readFileSync(new URL('../../i18n/'+language+'.json',import.meta.url),'utf8')) } } });
  const buttons = [], requests = [], state = new Map([
    [1,authorized], [2,[{ salesAgentId:'demo-agent',salesAgentName:'Agente Sintético' }]], [3,'demo-agent'],
    [10,[{ callId:'demo-call',callName:'Muestra',bucketDay:'2026-09-21',overallScore:80 }]], [11,['demo-call']],
  ]);
  let index=0;
  const modules = {
    react:{ ...React, useState:(initial)=>{ const key=index++; const value=state.has(key)?state.get(key):typeof initial==='function'?initial():initial; return [value,()=>{}]; },useEffect:()=>{} },
    'react/jsx-runtime':require('react/jsx-runtime'),
    'react-i18next':{ useTranslation:()=>({t:locale.t.bind(locale)}) },
    'lucide-react':{ Download:()=>null,FileText:()=>null,RefreshCw:()=>null },
    '@/components/kesp/primitives':{
      Button:({children,onClick,disabled})=>{ buttons.push({children,onClick,disabled});return React.createElement('button',{disabled},children); },
      Pill:({children})=>React.createElement('span',null,children), Section:({children})=>React.createElement('section',null,children),
    },
    '@/contexts/useAuth':{useAuth:()=>({user:{uid:'allowed-viewer'}})},
    '@/services/organizations':{isConsubancoSupervisorOrAdminMember:()=>authorized,subscribeToConsubancoMembership:()=>()=>{}},
    '@/lib/demoReportPeriod':{previousDemoWeek:()=>previousDemoWeek(new Date('2026-10-01T21:00:00Z'))},
    '@/lib/kespDemoRedaction':redaction,
    '@/services/functions':{
      listAgentEmailReportRecipients:async()=>{throw Error('Unexpected effect during render');},
      listAgentCoachingReportCalls:async(input)=>{requests.push({name:'list',input});return{rows:[]};},
      generateAgentCoachingReport:async(input)=>{requests.push({name:'generate',input});return{report:{},pdfBase64:null};},
    },
  };
  const exports={};runInNewContext(source,{exports,require:(name)=>{assert.ok(name in modules,name);return modules[name];}});
  const html=renderToStaticMarkup(React.createElement(exports.EmailReportsPage));
  return{html,buttons,requests};
}
for(const language of ['es','en']) {
  test(language+' demo report page renders translated manual controls with no sending actions', async()=>{
    const {html,buttons,requests}=render(true,language);
    assert.doesNotMatch(html,/kesp\.emailReports|demo\.reports|common\.refresh/);
    assert.doesNotMatch(html,/Enviar|Send|Ivan|Iván|mapping|mapeo/i);
    assert.match(html,/2026-09-21/);assert.match(html,/2026-09-27/);
    assert.doesNotMatch(html,/Agente Sintético/);
    const load=buttons.find((button)=>/Cargar llamadas|Load calls/.test(button.children));
    assert.ok(load);await load.onClick();
    const generate=buttons.find((button)=>/Generar reporte|Generate report/.test(button.children));
    assert.ok(generate);await generate.onClick();
    assert.equal(requests.length,2);
    assert.equal(requests[0].name,'list');assert.equal(requests[1].name,'generate');
    assert.equal(requests[1].input.salesAgentId,'demo-agent');assert.equal(requests[1].input.includePdf,true);
    assert.equal(requests[1].input.reportType,'weekly');assert.equal(requests[1].input.selectedCallIds[0],'demo-call');
  });
  test(language+' unauthorized report page exposes no action controls',()=>{
    const {html,buttons,requests}=render(false,language);
    assert.equal(buttons.length,0);assert.equal(requests.length,0);assert.match(html,/role="status"/);
  });
}
