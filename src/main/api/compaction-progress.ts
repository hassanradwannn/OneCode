/** One durable presentation row per local API handoff. This is not a native continuation ticket. */
import { appendEvent } from '../session/store.js';
import { notifyChanged } from '../session/recorder.js';
import type { ApiCompactionProgress } from '../../shared/session.js';
import type { ApiCompactionUpdate } from './compaction.js';

export function apiCompactionProgress(sessionId:string,id:string,manual:boolean,turnId?:string){
  let latest:ApiCompactionProgress={id,manual,state:'archiving'};
  return async(text:string,update:ApiCompactionUpdate)=>{
    const stage=update.state==='archiving'?'archive':['summarizing','merging'].includes(update.state)?'summary':update.state==='saving'?'save':
      ['saved','resumed','unchanged'].includes(update.state)?'resume':latest.stage;
    latest={...latest,...update,id,manual,
      ...(stage?{stage}:{}),
      ...(!['retrying','failed'].includes(update.state)?{reasonCode:undefined}:{})};
    await appendEvent(sessionId,{kind:'progress',source:'app',time:Date.now(),...(turnId?{turnId}:{}),
      progressId:'api-compaction:'+id,message:{text,chars:text.length,truncated:false},apiCompaction:latest});
    notifyChanged(sessionId);
  };
}
