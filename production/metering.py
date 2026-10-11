#!/usr/bin/env python3
"""Durable AMI hourly metering using only the customer EC2 instance role.
No seller credentials. Unreported closed buckets are immutable and retried.
"""
import datetime, hashlib, json, os, sqlite3, subprocess, sys, time, urllib.request
PRODUCT='3hyc116h3x52n2wgchrbqchu7'
DB='/var/lib/openttt/v2/admission.sqlite'
def identity():
    base='http://169.254.169.254/latest/'
    token=urllib.request.urlopen(urllib.request.Request(base+'api/token',method='PUT',headers={'X-aws-ec2-metadata-token-ttl-seconds':'60'}),timeout=2).read().decode()
    def get(path): return urllib.request.urlopen(urllib.request.Request(base+path,headers={'X-aws-ec2-metadata-token':token}),timeout=2).read().decode()
    dimension=get('meta-data/instance-type')
    if dimension not in ('t3.micro','t3.small','t3.medium'): raise ValueError('unsupported metering dimension')
    return get('meta-data/instance-id'),dimension,get('meta-data/placement/region')
def report(bucket,qty,instance,dimension,region,dry=False):
    payload={'ProductCode':PRODUCT,'Timestamp':datetime.datetime.fromtimestamp(bucket*3600,datetime.timezone.utc).isoformat(),'UsageDimension':dimension,'UsageQuantity':qty,'ClientToken':hashlib.sha256(f'{PRODUCT}:{instance}:{bucket}:{dimension}'.encode()).hexdigest(),'DryRun':dry}
    # Force CLI to use instance credentials; never inherit a seller profile/key.
    env={'PATH':os.environ.get('PATH','/usr/bin:/bin'),'HOME':'/nonexistent','AWS_CONFIG_FILE':'/dev/null','AWS_SHARED_CREDENTIALS_FILE':'/dev/null','AWS_EC2_METADATA_DISABLED':'false','AWS_PAGER':'','AWS_DEFAULT_REGION':region}
    r=subprocess.run(['/usr/bin/aws','meteringmarketplace','meter-usage','--cli-input-json',json.dumps(payload),'--output','json','--cli-connect-timeout','3','--cli-read-timeout','5'],env=env,capture_output=True,text=True,timeout=20)
    if r.returncode: raise ValueError('METER_USAGE_REJECTED')
    return json.loads(r.stdout)
def flush(db,now,send):
    hour=int(now)//3600
    for bucket,qty in db.execute('SELECT hour,quantity FROM usage WHERE reported=0 AND hour<? ORDER BY hour',(hour,)).fetchall():
        if now-bucket*3600>6*3600: continue # retain expired records for reconciliation
        send(bucket,qty)
        db.execute('UPDATE usage SET reported=1 WHERE hour=?',(bucket,));db.commit()
def main():
    db=sqlite3.connect(DB,timeout=3);db.execute('PRAGMA journal_mode=WAL');db.execute('PRAGMA synchronous=FULL')
    db.execute('CREATE TABLE IF NOT EXISTS usage(hour INTEGER PRIMARY KEY,quantity INTEGER NOT NULL,reported INTEGER NOT NULL DEFAULT 0)');db.commit()
    while True:
        try:
            instance,dimension,region=identity()
            report(int(time.time())//3600,0,instance,dimension,region,True)
            flush(db,time.time(),lambda h,q:report(h,q,instance,dimension,region))
            print('AMI_METERING_READY',flush=True)
        except Exception: print('AMI_METERING_UNAVAILABLE: check instance IAM role, Marketplace subscription and network; usage retained',flush=True)
        time.sleep(60)
if __name__=='__main__':main()
