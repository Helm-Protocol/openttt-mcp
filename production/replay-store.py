#!/usr/bin/env python3
"""Local single-node claim + receipt transaction. No network or Redis dependency.

Retain receipts, reclaim only the nonce index beyond its signed validity window.
Persist the greatest admitted TAI instant; clock rollback below it fails closed.
SQLite FULL sync precedes every acknowledged admission.
"""
import json, math, os, sqlite3, subprocess, sys, time
db = sqlite3.connect(sys.argv[1], timeout=3)
db.execute('PRAGMA journal_mode=WAL')
db.execute('PRAGMA synchronous=FULL')
db.execute('BEGIN IMMEDIATE')
legacy = db.execute("PRAGMA table_info(claims)").fetchall()
if legacy and 'receipt' in {r[1] for r in legacy}:
    # Preserve the earlier schema and migrate every live claim; never reset replay.
    db.execute('ALTER TABLE claims RENAME TO legacy_claims_v1')
db.execute('CREATE TABLE IF NOT EXISTS claims (claim TEXT PRIMARY KEY, expires_us INTEGER NOT NULL)')
db.execute('CREATE INDEX IF NOT EXISTS claim_expiry ON claims(expires_us)')
db.execute('CREATE TABLE IF NOT EXISTS receipts (claim TEXT PRIMARY KEY, record TEXT NOT NULL, receipt TEXT NOT NULL)')
db.execute('CREATE TABLE IF NOT EXISTS clock_state (id INTEGER PRIMARY KEY CHECK(id=1), high_water_us INTEGER NOT NULL)')
db.execute('INSERT OR IGNORE INTO clock_state VALUES (1,0)')
if legacy and 'receipt' in {r[1] for r in legacy}:
    for claim,record,receipt in db.execute('SELECT claim,record,receipt FROM legacy_claims_v1').fetchall():
        raw=bytes.fromhex(record)
        expiry=int.from_bytes(raw[4:12],'big')+600_000_000+int.from_bytes(raw[12:16],'big')+1_000_000
        db.execute('INSERT INTO claims VALUES (?,?)',(claim,expiry))
        db.execute('INSERT INTO receipts VALUES (?,?,?)',(claim,record,receipt))
        admitted=int(json.loads(receipt)['admitted_tai_us'])
        db.execute('UPDATE clock_state SET high_water_us=max(high_water_us,?) WHERE id=1',(admitted,))
db.commit()
tracking_cache=None
tracking_checked=0.0
def now_tai():
    global tracking_cache,tracking_checked
    now=time.clock_gettime_ns(time.CLOCK_TAI)//1000
    offset=round((time.clock_gettime_ns(time.CLOCK_TAI)-time.time_ns())/1_000_000_000)
    if offset<10 or offset>100: raise ValueError('TAI_CLOCK_NOT_CONFIGURED')
    if now<db.execute('SELECT high_water_us FROM clock_state WHERE id=1').fetchone()[0]: raise ValueError('TAI_CLOCK_ROLLBACK')
    if tracking_cache is None or time.monotonic()-tracking_checked>1:
        fields=subprocess.check_output(['chronyc','-c','tracking'],text=True,timeout=1).strip().split(',')
        if len(fields)!=14 or fields[13]!='Normal' or not 0<int(fields[2])<16: raise ValueError('CLOCK_NOT_SYNCHRONIZED')
        if abs(time.time()-float(fields[3]))>180: raise ValueError('CLOCK_SOURCE_STALE')
        dispersion=math.ceil((abs(float(fields[4]))+float(fields[10])/2+float(fields[11]))*1_000_000)
        if not 0<=dispersion<=1000: raise ValueError('CLOCK_DISPERSION_EXCEEDS_PROFILE')
        tracking_cache=dispersion;tracking_checked=time.monotonic()
    return now,offset,tracking_cache
for line in sys.stdin:
    try:
        if len(line) > 16384: raise ValueError('oversized store request')
        q = json.loads(line)
        if q['op'] == 'clock':
            now,offset,dispersion=now_tai()
            result = {'id':q['id'], 'ok':True, 'now_us':now, 'offset_seconds':offset,'dispersion_us':dispersion}
        elif q['op'] == 'claim':
            db.execute('BEGIN IMMEDIATE')
            now,_,_=now_tai()
            # Last signed validity instant + safety margin was derived by Rust.
            expires=int(q['expires_us'])
            if expires<=now: raise ValueError('CLAIM_ALREADY_EXPIRED')
            if now>int(q.get('valid_until_us',expires-1_000_000)): raise ValueError('TOKEN_EXPIRED_BEFORE_CLAIM')
            db.execute('DELETE FROM claims WHERE expires_us<?',(now,))
            if db.execute('SELECT 1 FROM claims WHERE claim=?',(q['claim'],)).fetchone():
                db.rollback(); result={'id':q['id'], 'ok':False,'reason':'REPLAY_DETECTED'}
            elif db.execute('SELECT count(*) FROM claims').fetchone()[0] >= int(os.environ.get('TTTPS_CLAIM_CAPACITY','1000000')):
                db.rollback();result={'id':q['id'],'ok':False,'reason':'REPLAY_CAPACITY'}
            else:
                db.execute('INSERT INTO claims VALUES (?,?)',(q['claim'],expires))
                db.execute('INSERT INTO receipts VALUES (?,?,?)',(q['claim'],q['record'],json.dumps(q['receipt'],separators=(',',':'))))
                db.execute('UPDATE clock_state SET high_water_us=? WHERE id=1',(now,))
                db.commit(); result={'id':q['id'],'ok':True}
        else: raise ValueError('unknown operation')
    except Exception as e:
        if db.in_transaction: db.rollback()
        result={'id':q.get('id',0) if isinstance(locals().get('q'),dict) else 0,'ok':False,'reason':'STORE_OR_CLOCK_UNAVAILABLE'}
    print(json.dumps(result,separators=(',',':')),flush=True)
