jest.mock('ioredis',()=>{const EventEmitter=require('events');return {__esModule:true,default:class extends EventEmitter {disconnect(){} get(){return Promise.resolve(null);}}};});
jest.mock('../telemetry',()=>({telemetryIncrement:jest.fn()}));
import {withTransportBinding} from '../transport_context';
import {potQuery, redis} from '../tools';
jest.mock('../server',()=>({delegateToServer:jest.fn(async()=>({data:{found:false,records:[],total_count:0}})),QuotaExceededError:class extends Error{}}));
import {delegateToServer} from '../server';
afterAll(()=>redis.disconnect());
test('HTTP tenant delegates using its validated key instead of the server credential',async()=>{
  const saved=process.env.TTT_API_KEY;process.env.TTT_API_KEY='fixture-server-credential';
  try {
    await withTransportBinding({authenticatedApiKey:'fixture-caller-key'},()=>potQuery({eventId:'fixture'}));
    expect(delegateToServer).toHaveBeenCalledWith(expect.objectContaining({apiKey:'fixture-caller-key'}));
  } finally {if(saved===undefined)delete process.env.TTT_API_KEY;else process.env.TTT_API_KEY=saved;}
});
test('anonymous HTTP context cannot inherit the server credential',async()=>{
  const saved=process.env.TTT_API_KEY;process.env.TTT_API_KEY='fixture-server-credential';
  (delegateToServer as jest.Mock).mockClear();
  try {
    await withTransportBinding({},()=>potQuery({eventId:'fixture'}));
    expect(delegateToServer).not.toHaveBeenCalled();
  } finally {if(saved===undefined)delete process.env.TTT_API_KEY;else process.env.TTT_API_KEY=saved;}
});
