"""Small deterministic SQLite restart/expiry/clock/capacity verification."""
import json, os, pathlib, subprocess, sys, tempfile
store=pathlib.Path(__file__).with_name('replay-store.py')
with tempfile.TemporaryDirectory() as temp:
    root=pathlib.Path(temp);db=root/'state.sqlite';clock=root/'clock'
    clock.write_text('1700000037000000')
    wrapper='import time,sys,runpy,pathlib,subprocess; p=pathlib.Path(sys.argv[2]); time.clock_gettime_ns=lambda c:int(p.read_text())*1000; time.time_ns=lambda:int(p.read_text())*1000-37000000000; time.time=lambda:int(p.read_text())/1000000-37; subprocess.check_output=lambda *a,**k:"A9FEA97B,169.254.169.123,4,"+str(time.time())+",0,0,0,0,0,0,0.0004,0.0002,16,Normal"; sys.argv=[sys.argv[0],sys.argv[1]]; runpy.run_path('+repr(str(store))+',run_name="__main__")'
    def start():return subprocess.Popen([sys.executable,'-u','-c',wrapper,str(db),str(clock)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,env={**os.environ,'TTTPS_CLAIM_CAPACITY':'1'})
    def call(p,q):p.stdin.write(json.dumps({'id':1,**q})+'\n');p.stdin.flush();return json.loads(p.stdout.readline())
    def stop(p):p.stdin.close();assert p.wait(timeout=5)==0
    p=start(); assert call(p,{'op':'clock'})['ok']
    q={'op':'claim','claim':'a','record':'00'*180,'receipt':{'admitted_tai_us':1700000037000000},'expires_us':1700000038000000}
    assert call(p,q)['ok'];assert call(p,q)['reason']=='REPLAY_DETECTED';stop(p)
    p=start();assert call(p,q)['reason']=='REPLAY_DETECTED'
    assert call(p,{**q,'claim':'b'})['reason']=='REPLAY_CAPACITY'
    clock.write_text('1700000036000000');assert not call(p,{'op':'clock'})['ok'];assert not call(p,{**q,'claim':'b'})['ok']
    clock.write_text('1700000039000000');assert call(p,{**q,'claim':'b','expires_us':1700000040000000})['ok'];stop(p)
    import sqlite3
    c=sqlite3.connect(db);assert c.execute('SELECT count(*) FROM claims').fetchone()[0]==1;assert c.execute('SELECT count(*) FROM receipts').fetchone()[0]==2
    print('PASS: durable replay, atomic claim, capacity fail closed, rollback fail closed, safe expiry, receipts retained')
