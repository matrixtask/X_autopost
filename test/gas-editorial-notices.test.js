import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('editorial decision notices preserve actor, reason and original thread; Slack failure leaves a diagnostic', () => {
  const sent=[], logs=[];
  const ctx=vm.createContext({console,SHEET:{INTERVIEWS:'Interviews'},readTable:()=>[{session_id:'s',thread_ts:'ts_12345.678'}],logEvent:(...args)=>logs.push(args)});
  vm.runInContext(fs.readFileSync(new URL('../gas/src/Slack.js',import.meta.url),'utf8'),ctx);
  ctx.sendSlack=(...args)=>{sent.push(args);return {ok:true};};
  const row={id:'p1',session_id:'s',text:'本人の本文 <@U1>'};
  assert.equal(ctx.notifyEditorialDecision(row,'hold','前提が分からないので主語を補う'),true);
  assert.equal(sent[0][1],'12345.678'); assert.match(sent[0][0],/審査で保留/);
  assert.match(sent[0][0],/主語を補う/); assert.match(sent[0][0],/&lt;@U1&gt;/);
  ctx.notifyEditorialDecision(row,'rejected','本人が見送りを選択'); assert.match(sent[1][0],/見送りになりました/);
  ctx.notifyEditorialDecision({...row,thread_ts:'ts_9999.001'},'no_material','公開できる材料がない');
  assert.equal(sent[2][1],'9999.001'); assert.match(sent[2][0],/下書き生成を見送り/);
  ctx.notifySlack=()=>null; assert.equal(ctx.notifyEditorialDecision(row,'hold','理由'),false);
  assert.equal(logs[0][0],'editorial_notice_failed');
});
