import test from "node:test";
import assert from "node:assert/strict";
import { configureMarketEndpoint, fetchAlphaQuote } from "../market-data.js";

test("proxy sends no personal key and preserves upstream timestamp",async()=>{
  const original=globalThis.fetch;
  try {
    configureMarketEndpoint("https://example.com/api/market");
    globalThis.fetch=async(url)=>{
      assert.equal(new URL(url).searchParams.has("apikey"),false);
      assert.equal(new URL(url).searchParams.get("symbol"),"QQQI");
      return {ok:true,json:async()=>({"Global Quote":{"05. price":"100"},_fetchedAt:"2026-09-04T12:00:00Z"})};
    };
    assert.equal((await fetchAlphaQuote("QQQI","PERSONAL-SECRET")).fetchedAt,"2026-09-04T12:00:00Z");
    assert.throws(()=>configureMarketEndpoint("http://example.com/api/market"));
    assert.throws(()=>configureMarketEndpoint("https://user:password@example.com/api/market"));
    assert.throws(()=>configureMarketEndpoint("https://example.com/api/market?key=secret"));
  } finally { globalThis.fetch=original;configureMarketEndpoint(""); }
});
