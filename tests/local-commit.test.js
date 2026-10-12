import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ulda, SocketIoTransport } from '../src/index.js';
import { fixture } from './server.js';
import { masterCredentials, envelope, open, seal, sealedWire } from '../src/crypto.js';
import { advance } from '../src/core.js';

async function until(condition) {
  for (let i=0;i<200;i++) {
    if (condition()) return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail('Expected client state was not reached');
}
async function setup(t) {
  const server=await fixture(), clients=[];
  const client=(timeout=3000)=>{
    const transport=new SocketIoTransport(server.url,{allowInsecureLocalhost:true,timeout});
    const trace=[], errors=[];
    transport.on('trace', event=>trace.push(event));
    const ulda=new Ulda(server.url,{transport});
    ulda.on('trace', event=>trace.push(event)); ulda.on('error', error=>errors.push(error.code));
    const entry={ulda,transport,trace,errors}; clients.push(entry); return entry;
  };
  t.after(async()=>{for(const {ulda} of clients) await ulda.close();await server.close();});
  return {server,client,password:'synthetic-local-commit-password'};
}
function holdNextAck(server, action) {
  let release;
  const held=new Promise(resolve=>server.faults.push({action,holdAck:send=>{release=send;resolve();}}));
  return {held,release:()=>release?.()};
}

test('Register activates the exact local master after ACK: one KDF, no Read, add works immediately', async t=>{
  const {server,client,password}=await setup(t), a=client();
  const master=await a.ulda.register(password);
  assert.equal(a.ulda.status,'open'); assert.equal(Object.keys(a.ulda.snapshot()).length,0);
  assert.deepEqual(server.frames.map(x=>x.action),['hello','create']);
  assert.equal(a.trace.filter(x=>x.step==='master.key.derive').length,1);
  assert.equal(a.trace.some(x=>x.step==='master.read'||x.step==='master.decrypt'),false);
  assert.ok(a.trace.some(x=>x.step==='master.local.accepted'&&x.ids[0]===master));
  await a.ulda.add('item',{value:1});
  assert.deepEqual(server.frames.map(x=>x.action),['hello','create','create','update']);
  assert.equal(a.ulda.value('item').value,1);
  assert.equal(a.trace.some(x=>x.phase==='push'),false);
  await assert.rejects(a.ulda.register(password),{code:'BUSY'});
  const b=client(); await b.ulda.connect(master,password);
  assert.equal(b.ulda.value('item').value,1);
  assert.deepEqual(a.errors,[]);
});

test('A foreign update received before the Create ACK is queued and applied after local activation', async t=>{
  const {server,client,password}=await setup(t), a=client(), b=client();
  const gate=holdNextAck(server,'create'); t.after(gate.release);
  const registration=a.ulda.register(password); await gate.held;
  assert.throws(()=>a.ulda.snapshot(),{code:'NOT_OPEN'});
  await assert.rejects(a.ulda.register(password),{code:'BUSY'});
  const master=[...server.records.keys()][0];
  await b.ulda.connect(master,password); await b.ulda.add('remote',{value:7});
  await until(()=>a.trace.some(x=>x.phase==='push'));
  gate.release(); assert.equal(await registration,master);
  await until(()=>a.ulda.snapshot().remote?.value===7);
  assert.equal(a.ulda.status,'open'); assert.deepEqual(a.errors,[]);
  const author=server.frames.find(x=>x.action==='create').socket;
  assert.equal(server.frames.some(x=>x.socket===author&&x.action==='read'&&x.body.includes(master)),false);
});

test('Closing during a held Create ACK cannot reactivate a closed SDK', async t=>{
  const {server,client,password}=await setup(t), a=client();
  const gate=holdNextAck(server,'create'); t.after(gate.release);
  const result=a.ulda.register(password).then(()=>assert.fail('Registration unexpectedly succeeded'),error=>error.code);
  await gate.held; await a.ulda.close(); gate.release();
  assert.ok(['CLOSED','UNKNOWN_OUTCOME'].includes(await result));
  assert.equal(a.ulda.status,'closed'); assert.throws(()=>a.ulda.snapshot(),{code:'CLOSED'});
  assert.equal(server.frames.filter(x=>x.action==='create').length,1);
  assert.equal(server.subscriptions.size,0);
});

test('Lost Create, lost ACK or invalid Create ACK does not activate local state or replay Create', async t=>{
  const {server,client,password}=await setup(t);
  for(const fault of [{dropRequest:true},{dropAck:true},{response:()=>({ok:true,data:['invalid-id']})}]){
    const a=client(150); server.faults.push({action:'create',...fault});
    const start=server.frames.length, resources=server.records.size;
    await assert.rejects(a.ulda.register(password),{code:'UNKNOWN_OUTCOME'});
    assert.throws(()=>a.ulda.snapshot(),{code:'NOT_OPEN'});
    assert.equal(a.trace.some(x=>x.step==='master.local.accepted'),false);
    assert.equal(server.frames.slice(start).filter(x=>x.action==='create').length,1);
    assert.equal(a.trace.find(x=>x.phase==='send'&&x.event==='ulda:create')?.volatile,true);
    assert.equal(server.records.size,resources+(fault.dropRequest?0:1));
    await a.ulda.close();
  }
});

test('No echo: ACK updates the author locally, other connections still receive Update and Delete', async t=>{
  const {client,password}=await setup(t), a=client(), b=client(), c=client();
  const master=await a.ulda.register(password); await a.ulda.add('item',{value:0});
  await b.ulda.connect(master,password); await c.ulda.connect(master,password);
  a.trace.length=b.trace.length=c.trace.length=0;
  await a.ulda.update('item',{value:1});
  await until(()=>b.ulda.value('item').value===1&&c.ulda.value('item').value===1);
  assert.equal(a.ulda.value('item').value,1);
  assert.equal(a.trace.filter(x=>x.phase==='push').length,0);
  assert.equal(b.trace.filter(x=>x.phase==='push').length,1);
  assert.equal(c.trace.filter(x=>x.phase==='push').length,1);
  await b.ulda.update('item',{value:2});
  await until(()=>a.ulda.value('item').value===2&&c.ulda.value('item').value===2);
  a.trace.length=b.trace.length=c.trace.length=0;
  await a.ulda.delete('item');
  await until(()=>!Object.hasOwn(b.ulda.snapshot(),'item')&&!Object.hasOwn(c.ulda.snapshot(),'item'));
  assert.equal(a.trace.some(x=>x.phase==='push'),false);
  for(const peer of [b,c]) assert.equal(peer.trace.filter(x=>x.phase==='push'&&x.deleted.length===1).length,1);
  assert.deepEqual(a.errors,[]); assert.deepEqual(b.errors,[]); assert.deepEqual(c.errors,[]);
});

test('Foreign X successor before our Update ACK is verified through our sent candidate, never rolled back by late ACK', async t=>{
  const {server,client,password}=await setup(t), a=client(), b=client();
  const master=await a.ulda.register(password); await a.ulda.add('item',{value:0}); await b.ulda.connect(master,password);
  const gate=holdNextAck(server,'update'); t.after(gate.release);
  let acked=false;
  const write=a.ulda.update('item',{value:1}).then(()=>{acked=true;});
  await gate.held; await until(()=>b.ulda.value('item').value===1);
  await b.ulda.update('item',{value:2});
  await until(()=>a.ulda.value('item').value===2);
  assert.equal(acked,false); assert.deepEqual(a.errors,[]);
  gate.release(); await write;
  assert.equal(a.ulda.value('item').value,2); assert.equal(a.ulda.status,'open');
});

test('Foreign edit to newly created content before Add ACK is retained without publishing the pending catalog', async t=>{
  const {server,client,password}=await setup(t), a=client(), b=client();
  const master=await a.ulda.register(password); await b.ulda.connect(master,password);
  const gate=holdNextAck(server,'update'); t.after(gate.release);
  const add=a.ulda.add('new',{value:1}); await gate.held;
  await until(()=>b.ulda.snapshot().new?.value===1);
  await b.ulda.update('new',{value:2});
  await until(()=>a.trace.some(x=>x.step==='changed.memory'));
  assert.equal(Object.hasOwn(a.ulda.snapshot(),'new'),false);
  gate.release(); await add;
  assert.equal(a.ulda.value('new').value,2); assert.deepEqual(a.errors,[]);
});

test('Foreign master changes before Add ACK advance local catalog through the sent master candidate', async t=>{
  const {server,client,password}=await setup(t), a=client(), b=client();
  const master=await a.ulda.register(password); await b.ulda.connect(master,password);
  const gate=holdNextAck(server,'update'); t.after(gate.release);
  const add=a.ulda.add('first',{value:1}); await gate.held;
  await until(()=>b.ulda.snapshot().first?.value===1);
  await b.ulda.add('second',{value:2});
  await until(()=>a.ulda.snapshot().second?.value===2);
  gate.release(); await add;
  assert.equal(a.ulda.value('first').value,1); assert.equal(a.ulda.value('second').value,2);
  assert.deepEqual(a.errors,[]);
});

test('Foreign deletion before Add ACK does not resurrect the removed resource', async t=>{
  const {server,client,password}=await setup(t), a=client(), b=client();
  const master=await a.ulda.register(password); await b.ulda.connect(master,password);
  const gate=holdNextAck(server,'update'); t.after(gate.release);
  const add=a.ulda.add('ephemeral',{value:1}); await gate.held;
  await until(()=>b.ulda.snapshot().ephemeral?.value===1);
  await b.ulda.delete('ephemeral');
  await until(()=>a.trace.some(x=>x.phase==='push'&&x.deleted?.length===1));
  gate.release(); await add;
  assert.equal(Object.hasOwn(a.ulda.snapshot(),'ephemeral'),false);
  await a.ulda.add('ephemeral',{value:3});
  assert.equal(a.ulda.value('ephemeral').value,3); assert.deepEqual(a.errors,[]);
});

test('A foreign successor cannot turn a lost own ACK into success', async t=>{
  const {server,client,password}=await setup(t), a=client(350), b=client();
  const master=await a.ulda.register(password); await a.ulda.add('item',{value:0}); await b.ulda.connect(master,password);
  server.faults.push({action:'update',dropAck:true});
  const failed=assert.rejects(a.ulda.update('item',{value:1}),{code:'UNKNOWN_OUTCOME'});
  await until(()=>b.ulda.value('item').value===1);
  await b.ulda.update('item',{value:2});
  await until(()=>a.ulda.value('item').value===2);
  await failed;
  assert.throws(()=>a.ulda.update('item',{value:3}),{code:'NEEDS_RESYNC'});
  await a.ulda.refresh(); await a.ulda.update('item',{value:3});
  assert.equal(a.ulda.value('item').value,3);
});

test('No-echo verification still rejects an X gap without a known sent intermediate candidate', async t=>{
  const {server,client,password}=await setup(t), a=client();
  const master=await a.ulda.register(password), record=server.records.get(master);
  const credentials=await masterCredentials(password,envelope(record.payload).salt);
  const state=await open(credentials,record);
  const future=sealedWire(await seal(credentials,state.token,advance(advance(state.origin)),state.data));
  server.sendChanged({updated:[{id:master,...future}],deleted:[]});
  await until(()=>a.ulda.status==='needsResync');
  assert.deepEqual(a.errors,['NEEDS_RESYNC']);
  assert.equal(Object.keys(a.ulda.snapshot()).length,0);
});
