import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function fixture(enabled = true) {
  const db = { Interviews: [], Stock: [] }, logs = [], triggers = [], writes = [];
  if (enabled) for (const name of ['SourceRevisions', 'EditorialHistory', 'ArticleDrafts', 'ArticleSources']) db[name] = [];
  let seq = 0, owned = false, released = 0;
  const spreadsheet = {
    getSheetByName: name => db[name] ? { name } : null,
    insertSheet: name => { db[name] = []; },
  };
  const lock = { hasLock: () => owned, tryLock: () => { owned = true; return true; }, releaseLock: () => { owned = false; released++; } };
  const ctx = vm.createContext({ console, Date,
    ss: () => spreadsheet, getProp: (_k, fallback) => fallback,
    readTable: name => structuredClone(db[name] || []),
    appendRowsObj: (name, rows) => { db[name].push(...structuredClone(rows)); writes.push([name, rows.length]); },
    appendRowObj: (name, row) => { db[name].push(structuredClone(row)); },
    ensureHeaders: () => {}, logEvent: (...args) => logs.push(args),
    nowJst: () => new Date(), fmtDateTime: date => date.toISOString(), newId: prefix => prefix + (++seq),
    LockService: { getScriptLock: () => lock },
    SpreadsheetApp: { flush: () => {} },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      getUuid: () => 'uuid-' + (++seq),
      computeDigest: (_algorithm, value) => [...createHash('sha256').update(value).digest()] },
    ScriptApp: { getProjectTriggers: () => triggers.map(name => ({ getHandlerFunction: () => name })),
      newTrigger: name => ({ forSpreadsheet: () => ({ onEdit: () => ({ create: () => triggers.push(name) }) }) }) },
    assertAccess: () => {}, syncStockRowToNotion: () => {},
    updateStockById: (id, updates) => Object.assign(db.Stock.find(r => r.id === id), structuredClone(updates)),
    setColumnByRows: (_name, column, entries) => entries.forEach(e => { db.Stock.find(r => r._row === e.row)[column] = e.value; }),
    scheduleApprovedPosts: () => [], runQualityGate: () => {},
  });
  for (const name of ['Pure', 'Config', 'ArticleArchive', 'EditorialCouncil', 'Interview', 'Drafts', 'PostComposition', 'WebApp']) {
    vm.runInContext(readFileSync(new URL(`../gas/src/${name}.js`, import.meta.url), 'utf8'), ctx);
  }
  // Config declares real property helpers; restore the fixture's non-secret property reader.
  ctx.getProp = (_k, fallback) => fallback;
  ctx.newId = prefix => prefix + (++seq);
  ctx.fmtDateTime = date => date.toISOString();
  ctx.nowJst = () => new Date();
  ctx.assertAccess = () => {};
  ctx.getSheet = name => ({ getRange: (row, col) => ({ setValue: value => {
    db[name].find(r => r._row === row)[ctx.SHEET_HEADERS.Interviews[col - 1]] = value;
  } }) });
  ctx.SHEET_HEADERS = { Interviews: ['answer', 'answered_at', 'followup_answer', 'followup_answered_at'] };
  return { ctx, db, logs, writes, triggers, lock, get released() { return released; } };
}
const answer = () => ({ session_id: 's', idx: 1, _row: 2, theme: '試験', question: '次は何を試しますか？',
  answer: 'まだ仮説です。小さく試します。', answered_at: '2026-09-01 09:00', thread_ts: 'ts_100.000001' });
const post = () => ({ id: 'p', _row: 2, session_id: 's', source_idx: '1', text: 'AIが書いた草稿', status: 'draft' });

test('archive: setup is additive, batched and repeatable, retaining existing content and triggers', () => {
  const h = fixture(false);
  h.db.Interviews.push(...Array.from({ length: 100 }, (_, i) => ({ ...answer(), idx: i + 1, _row: i + 2 })));
  h.db.Stock.push(post());
  h.triggers.push('postTick');
  h.ctx.setupArticleArchive();
  h.ctx.setupArticleArchive();
  assert.equal(h.db.SourceRevisions.length, 100);
  assert.equal(new Set(h.db.SourceRevisions.map(r => r.revision_id)).size, 100);
  assert.equal(h.db.EditorialHistory.length, 1);
  assert.deepEqual(h.triggers, ['postTick', 'onArticleArchiveEdit']);
  assert.equal(h.db.Stock[0].text, 'AIが書いた草稿');
  assert.equal(h.db.SourceRevisions[0].source_time, '2026-09-01 09:00');
  assert.notEqual(h.db.SourceRevisions[0].observed_at, h.db.SourceRevisions[0].source_time);
  assert.equal(h.db.SourceRevisions[0].publication_scope, 'review_required');
  assert.equal(h.db.EditorialHistory[0].actor_type, 'unknown');
  assert.equal(h.db.EditorialHistory[0].source_revision_ids, ''); // Do not fabricate old provenance.
  assert.equal(h.writes.filter(([name, n]) => name === 'SourceRevisions' && n > 0).length, 1);
});

test('archive: answer correction, followup, revert and clearing append versions without changing originals', () => {
  const h = fixture();
  h.db.Interviews.push(answer());
  h.ctx.captureArticleArchive();
  const original = structuredClone(h.db.SourceRevisions[0]);
  h.ctx.updateInterviewRow('s', 1, { answer: '試す前に条件を決めます。' });
  h.ctx.updateInterviewRow('s', 1, { followup_answer: '今回は荷重です。', followup_answered_at: '2026-09-02 09:00' });
  h.ctx.updateInterviewRow('s', 1, { answer: answer().answer });
  h.ctx.updateInterviewRow('s', 1, { answer: '' });
  assert.deepEqual(h.db.SourceRevisions[0], original);
  const versions = h.db.SourceRevisions.filter(r => r.source_field === 'answer');
  assert.equal(versions.length, 4);
  assert.equal(versions[2].text, original.text);
  assert.notEqual(versions[2].revision_id, original.revision_id);
  assert.equal(versions[3].supersedes_revision_id, versions[2].revision_id);
  assert.equal(versions[3].deleted, 'true');
  assert.equal(h.db.SourceRevisions.filter(r => r.source_field === 'followup_answer').length, 1);
});

test('archive: future source bundle requires per-version consent, excludes AI and observes privacy/deletions', () => {
  const h = fixture();
  h.db.Interviews.push(answer()); h.db.Stock.push(post());
  h.ctx.captureArticleArchive();
  assert.equal(h.ctx.getArticleSourceBundle().length, 0);
  assert.equal(h.ctx.getArticleSourceBundle(true).length, 1);
  h.db.SourceRevisions[0].publication_scope = 'allowed';
  assert.equal(h.ctx.getArticleSourceBundle().length, 1);
  h.db.Interviews[0].answer = '修正後の判断';
  assert.equal(h.ctx.getArticleSourceBundle().length, 0); // Not yet observed: don't expose stale allowed text.
  h.ctx.captureArticleArchive();
  assert.equal(h.db.SourceRevisions.at(-1).publication_scope, 'review_required');
  h.db.SourceRevisions.at(-1).publication_scope = 'private';
  h.db.Interviews[0].answer = 'さらに訂正'; h.ctx.captureArticleArchive();
  assert.equal(h.db.SourceRevisions.at(-1).publication_scope, 'private');
  assert.equal(h.ctx.getArticleSourceBundle(true).length, 0);
  h.db.SourceRevisions.at(-1).publication_scope = 'allowed';
  h.db.Interviews.length = 0;
  assert.equal(h.ctx.getArticleSourceBundle().length, 0);
});

test('archive: human editing and approval preserve model text but do not label AI scoring as human preference', () => {
  const h = fixture(); h.db.Stock.push(post());
  h.ctx.archiveEditorialRows(h.db.Stock, 'model', 'generated');
  h.ctx.runQualityGate = () => { h.db.Stock[0].status = 'ready'; };
  h.ctx.api_updateText('token', 'p', '本人が直した表現', '一般論を消した');
  const edit = h.db.EditorialHistory.at(-1);
  assert.equal(edit.actor_type, 'user'); assert.equal(edit.event_type, 'text_edited');
  assert.equal(edit.text, '本人が直した表現'); assert.equal(edit.reason, '一般論を消した');
  assert.equal(h.db.EditorialHistory[0].text, 'AIが書いた草稿');
  h.ctx.api_setStatus('token', 'p', 'approved');
  assert.equal(h.db.EditorialHistory.at(-2).actor_type, 'unknown'); // observed ready from scoring
  assert.equal(h.db.EditorialHistory.at(-1).actor_type, 'user');
  assert.equal(h.db.EditorialHistory.at(-1).status, 'approved');
  h.db.Stock[0].status = 'ready'; h.ctx.api_approveAll('token');
  assert.equal(h.db.EditorialHistory.at(-1).event_type, 'approved');
  h.db.Stock[0].status = 'stock'; h.ctx.api_forceApproveStock('token');
  assert.equal(h.db.EditorialHistory.at(-1).event_type, 'force_approved');
});

test('archive: generation failure still captures the source and successful drafts link to that immutable revision', () => {
  const h = fixture(); h.db.Interviews.push(answer());
  h.ctx.prepareEditorialCouncil = () => { throw new Error('reflection failure'); };
  assert.throws(() => h.ctx.generateDraftsFromInterview('s'), /reflection failure/);
  assert.equal(h.db.SourceRevisions.length, 1); assert.equal(h.db.Stock.length, 0);
  const quote = 'まだ仮説です。';
  h.ctx.prepareEditorialCouncil = () => ({ reflection: { anchors: [{ qi: 1, quote }] } });
  h.ctx.buildStylePrompt = () => ''; h.ctx.editorialCouncilInstructions = () => '';
  h.ctx.askClaudeJsonSalvageable = () => [{ qi: 1, core_quote: quote, text: quote + '小さく試します。' }];
  h.ctx.isRetiredTopic = () => false;
  h.ctx.generateDraftsFromInterview('s');
  assert.deepEqual(JSON.parse(h.db.Stock[0].source_revision_ids), [h.db.SourceRevisions[0].revision_id]);
  assert.equal(h.db.EditorialHistory[0].actor_type, 'model');
  h.ctx.updateInterviewRow('s', 1, { answer: '新しい判断' });
  assert.notEqual(JSON.parse(h.db.Stock[0].source_revision_ids)[0], h.db.SourceRevisions.at(-1).revision_id);
});

test('archive: the long-answer editor retains the exact primary and followup source revisions', () => {
  const h = fixture();
  const core = 'まだ仮説です。';
  h.db.Interviews.push({ ...answer(), answer: core + 'あ'.repeat(150), followup_answer: '条件を先に決めます。', followup_answered_at: '2026-09-01 10:00' });
  h.ctx.prepareEditorialCouncil = () => ({ version: 'test', reflection: { anchors: [{ qi: 1, quote: core }] } });
  h.ctx.buildStylePrompt = () => ''; h.ctx.editorialCouncilInstructions = () => ''; h.ctx.isRetiredTopic = () => false;
  h.ctx.askClaudeJson = () => [{ qi: 1, format: 'long', reason: '背景を残す', tradeoff: '分けると留保が消える', omitted: '',
    parts: [{ text: h.db.Interviews[0].answer, core_quote: core }] }];
  h.ctx.generateDraftsFromInterview('s');
  assert.equal(h.db.Stock[0].post_format, 'long');
  const ids = JSON.parse(h.db.Stock[0].source_revision_ids);
  assert.equal(ids.length, 2);
  assert.deepEqual(ids, h.db.SourceRevisions.map(r => r.revision_id));
  assert.equal(h.db.EditorialHistory[0].source_revision_ids, h.db.Stock[0].source_revision_ids);
  assert.equal(h.db.EditorialHistory[0].actor_type, 'model');
});

test('archive: a held interview lock is retained; archival failure does not erase or prevent a reply', () => {
  const h = fixture(); h.db.Interviews.push(answer());
  h.lock.tryLock(); h.ctx.captureArticleArchive();
  assert.equal(h.released, 0); assert.equal(h.lock.hasLock(), true);
  h.ctx.appendRowsObj = () => { throw new Error('sheet unavailable'); };
  h.ctx.updateInterviewRow('s', 1, { answer: '保存したい新しい回答' });
  assert.equal(h.db.Interviews[0].answer, '保存したい新しい回答');
  assert.ok(h.logs.some(([event]) => event === 'article_archive_error'));
});

test('archive: direct Sheet edit records only affected rows, and use before setup leaves the workflow available', () => {
  const h = fixture(false);
  h.db.Interviews.push(answer());
  h.ctx.updateInterviewRow('s', 1, { answer: '導入前も回答できる' });
  assert.equal(h.db.Interviews[0].answer, '導入前も回答できる');
  assert.equal(h.ctx.captureArticleArchive().enabled, false);
  h.ctx.setupArticleArchive();
  h.db.Interviews.push({ ...answer(), idx: 2, _row: 3 });
  h.db.Interviews[0].answer = 'シートで直接直した';
  h.ctx.onArticleArchiveEdit({ range: { getRow: () => 2, getLastRow: () => 2, getSheet: () => ({ getName: () => 'Interviews' }) } });
  assert.equal(h.db.SourceRevisions.at(-1).text, 'シートで直接直した');
  assert.equal(h.db.SourceRevisions.at(-1).change_origin, 'sheet_edit_observed');
  assert.ok(h.db.SourceRevisions.every(r => r.source_idx === '1'));
});
