import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMarketService, createServer } from "../server/server.mjs";

const quote = { "Global Quote": { "05. price": "100" } };
test("shared cache deduplicates concurrent requests and rejects arbitrary symbols/functions", async()=>{
  let calls=0; const service=await createMarketService({apiKey:"TEST",fetcher:async()=>{calls++;return {ok:true,json:async()=>quote};}});
  await Promise.all([service.get("GLOBAL_QUOTE","QQQI"),service.get("GLOBAL_QUOTE","QQQI")]); assert.equal(calls,1);
  await assert.rejects(service.get("BAD","QQQI"),{status:400});
  await assert.rejects(service.get("GLOBAL_QUOTE","UNKNOWN"),{status:400});
});
test("budget survives restarts and errors back off without caching failures as success",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tangping-test-")); const cacheFile=join(dir,"cache.json");
  try {
    let calls=0; const config={apiKey:"TEST",budget:1,cacheFile,fetcher:async()=>{calls++;throw new Error("TEST SECRET");}};
    const first=await createMarketService(config); await assert.rejects(first.get("GLOBAL_QUOTE","QQQI"),{status:503});
    const second=await createMarketService(config); await assert.rejects(second.get("GLOBAL_QUOTE","SPYI"),{status:429}); assert.equal(calls,1);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test("API serves cache with CORS, hides private files and secrets, fails clearly without key",async()=>{
  const service=await createMarketService(); const server=createServer(service,"https://example.com");
  await new Promise(r=>server.listen(0,"127.0.0.1",r)); const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const res=await fetch(base+"/api/market?function=GLOBAL_QUOTE&symbol=QQQI",{headers:{Origin:"https://example.com"}});
    assert.equal(res.status,503); assert.equal(res.headers.get("access-control-allow-origin"),"https://example.com");
    assert.equal((await fetch(base+"/.git/config")).status,404);
    assert.equal((await fetch(base+"/server/.env")).status,404);
    assert.equal((await fetch(base+"/api/market?function=GLOBAL_QUOTE&symbol=QQQI",{headers:{Origin:"https://evil.test"}})).status,403);
    assert.equal((await fetch(base+"/app.js?v=7")).status,200);
  } finally { await new Promise(r=>server.close(r)); }
});
