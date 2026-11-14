import assert from 'node:assert/strict';
import { it } from 'node:test';
import { stubFetch } from './helpers';
import { toResult } from '@/lib/agent/research/compare';
import { forgetRecentPages, readOffers } from '@/lib/agent/research/reader';
import type { RawOffer, RawResearch } from '@/lib/agent/research/types';
const offer = (change: Partial<RawOffer> = {}): RawOffer => ({ provider: 'Judge Energy', plan: 'Fixed', contractType: 'fixed', contractMonths: 12, monthlyPriceEur: 4, energyPriceCentsPerKwh: 9, setupFeeEur: 0, sourceUrl: 'https://example.com/judge', ...change });
const raw = (offers: RawOffer[], billType: RawResearch['billType'] = 'electricity'): RawResearch => ({ key: 'judge', billType, city: 'Helsinki', status: 'done', mock: false, query: 'electricity Helsinki', startedAt: 1000, finishedAt: 2000, pagesDone: 1, pagesTotal: 1, offers, citations: [], errors: [] });
it('electricity setup fee changes the first-year winner and savings', () => {
  const result = toResult(raw([offer({ provider: 'Low headline', energyPriceCentsPerKwh: 8, setupFeeEur: 120 }), offer({ provider: 'No opening fee' })]), 40, 2000);
  assert.equal(result.best?.provider, 'No opening fee');
  assert.equal(result.offers.find(o => o.provider === 'Low headline')?.estimatedMonthlyCostEur, 27.33);
});
it('negative or nonfinite fees never become savings', () => {
  for (const billType of ['electricity', 'mobile', 'internet'] as const) {
    for (const setupFeeEur of [-1000, Infinity, NaN]) {
      assert.equal(toResult(raw([offer({ setupFeeEur })], billType), 40, 2000).best, null);
    }
  }
  for (const monthlyPriceEur of [-100, Infinity, NaN]) {
    assert.equal(toResult(raw([offer({ monthlyPriceEur })]), 40, 2000).best, null);
  }
});
it('unknown electricity base fee is not silently treated as free', () => {
  const result = toResult(raw([offer({ monthlyPriceEur: null })]), 40, 2000);
  assert.equal(result.best, null);
  assert.equal(result.offers[0].estimatedYearlySavingEur, null);
});
it('concurrent requests share one page read and preserve unknown upstream age', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { MODEL_PROVIDER: 'nvidia', CONTEXT_DEV_API_KEY: 'test' });
  forgetRecentPages();
  let calls = 0;
  const restore = stubFetch(async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 20));
    return Response.json({ json: { success: true, data: { offers: [offer()] } } });
  });
  try {
    await Promise.all(Array.from({ length: 12 }, () => readOffers('https://example.com/judge', 'electricity')));
    assert.equal(calls, 1);
    assert.equal((await readOffers('https://example.com/judge', 'electricity')).cacheAgeMs, null);
  } finally {
    restore(); forgetRecentPages();
    for (const key of ['MODEL_PROVIDER', 'CONTEXT_DEV_API_KEY']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});

it('a cancelled plan cannot create new drafts, before start or after scanning', async () => {
  const { AINO, freshState } = await import('./helpers');
  const { runPlan } = await import('@/lib/agent/plan');
  const { listActions } = await import('@/lib/actions');
  for (const abortAt of ['before', 'scan', 'page_read']) {
    freshState();
    const controller = new AbortController();
    if (abortAt === 'before') controller.abort();
    for await (const event of runPlan(AINO, {}, controller.signal)) {
      if (event.type === abortAt) controller.abort();
    }
    assert.equal(listActions(AINO).length, 0, abortAt);
  }
});
