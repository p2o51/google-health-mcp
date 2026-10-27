import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTools, type Env } from '../src/tools.ts';
import { statistics, sleepAnalysis } from '../src/features.ts';
import { validateRecord } from '../src/writes.ts';
const env: Env={GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'test-secret',GOOGLE_REFRESH_TOKEN:'test-refresh',GOOGLE_TOKEN_URL:'https://token.test',GOOGLE_API_BASE:'https://health.test/v4'};
const ctx={env,headers:new Headers()};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status});
async function mock(respond:(url:URL,body:any)=>Response,run:()=>Promise<void>) {
  const saved=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{
    const req=new Request(input,init),url=new URL(req.url);
    if(url.origin==='https://token.test')return json({access_token:'test-access',scope:'https://www.googleapis.com/auth/googlehealth.sleep.readonly'});
    assert.equal(url.origin,'https://health.test');assert.equal(req.headers.get('Authorization'),'Bearer test-access');
    return respond(url,req.method==='POST'?await req.json():null);
  };
  try{await run();}finally{globalThis.fetch=saved;}
}
function call(name:string,args:Record<string,unknown>,current=env,scopes=['health:read']){
  const tool=buildTools(current,{scopes:new Set(scopes),resourceMetadataUrl:'https://mcp.test/metadata'}).find(t=>t.name===name);assert.ok(tool);
  return tool.handler(args,{...ctx,env:current});
}
const date={year:2026,month:10,day:20};
const hydration={interval:{startTime:'2026-10-20T10:00:00+09:00',endTime:'2026-10-20T10:00:00+09:00'},amountConsumed:{milliliters:250}};

test('missing data stays null, real zero contributes to statistics, midnight bedtimes remain close',()=>{
  assert.equal(statistics([],7).mean,null);assert.equal(statistics([0,10],7).mean,5);
  const sleep=sleepAnalysis([
    {interval:{startTime:'2026-10-19T23:50:00Z',endTime:'2026-10-20T07:00:00Z'},summary:{minutesAsleep:'400'}},
    {interval:{startTime:'2026-10-21T00:10:00Z',endTime:'2026-10-21T07:00:00Z'},summary:{minutesAsleep:'380'}},
  ],7);
  assert.equal(sleep.bedtime_variation_minutes,10);assert.equal(sleep.duration_minutes.observed_days,2);assert.equal(sleep.duration_minutes.mean,390);
});
test('report uses reconciled daily steps, correct dates, and preserves failed metrics',async()=>{
  let calls=0;
  await mock((url,body)=>{
    calls++;const type=url.pathname.split('/')[5];
    if(type==='steps'){
      assert.equal(body.windowSizeDays,1);assert.equal(body.dataSourceFamily,'users/me/dataSourceFamilies/all-sources');
      return json({rollupDataPoints:[{civilStartTime:{date},steps:{countSum:'0'}}]});
    }
    if(type==='daily-heart-rate-variability')return json({error:{message:'Permission denied'}},403);
    if(type==='daily-resting-heart-rate')return json({dataPoints:[{dailyRestingHeartRate:{date,beatsPerMinute:'60'}}]});
    return json({dataPoints:[]});
  },async()=>{
    const result=(await call('get_health_report',{start_date:'2026-10-20',end_date:'2026-10-26',compare_previous:false})).structured as any;
    assert.equal(result.current.metrics.steps.mean,0);assert.equal(result.current.metrics.steps.observed_days,1);
    assert.equal(result.current.metrics['daily-resting-heart-rate'].mean,60);
    assert.equal(result.current.metrics['daily-oxygen-saturation'].mean,null);
    assert.equal(result.current.complete,false);assert.match(result.current.errors['daily-heart-rate-variability'],/Permission denied/);assert.equal(calls,6);
  });
});
test('report compares prior equal-length period and excludes missing days and low-coverage claims',async()=>{
  await mock((url,body)=>{
    if(url.pathname.includes('/steps/')){
      const day=body.range.start.date.day;return json({rollupDataPoints:[{civilStartTime:{date:{...date,day}},steps:{countSum:day===20?'100':'50'}}]});
    }
    return json({dataPoints:[]});
  },async()=>{
    const r=(await call('get_health_report',{start_date:'2026-10-20',end_date:'2026-10-26',compare_previous:true})).structured as any;
    assert.equal(r.previous.start_date,'2026-10-13');assert.equal(r.previous.end_date,'2026-10-19');assert.equal(r.changes.steps.mean_change,50);
    assert.equal(r.changes.steps.percent_change,100);assert.equal(r.changes.steps.comparable,false);
  });
});
test('partial baseline failure keeps current report, pagination is bounded and marked',async()=>{
  await mock((url,body)=>{
    const filter=url.searchParams.get('filter')??'';
    if(filter.includes('2026-10-13') || body?.range?.start?.date?.day===13)return json({error:{message:'baseline unavailable'}},500);
    return url.pathname.includes('/steps/')?json({rollupDataPoints:[],nextPageToken:'remaining'}):json({dataPoints:[],nextPageToken:'remaining'});
  },async()=>{
    const r=(await call('get_health_report',{start_date:'2026-10-20',end_date:'2026-10-26'})).structured as any;
    assert.equal(r.current.truncated.length,6);assert.equal(r.previous,null);assert.match(r.previous_error,/All report queries failed/);
  });
});
test('report rejects reversed, invalid and excessive ranges before network',async()=>{
  await mock(()=>{throw new Error('unexpected network');},async()=>{
    for(const [start,end] of [['2026-10-27','2026-10-20'],['2026-02-30','2026-03-01'],['2026-09-01','2026-10-31']])await assert.rejects(call('get_health_report',{start_date:start,end_date:end}));
  });
});
test('workout splits preserve native data and convert millimeters and duration correctly',async()=>{
  await mock(url=>{assert.ok(url.pathname.endsWith('/dataPoints/run-1'));return json({exercise:{splitSummaries:[{activeDuration:'300s',metricsSummary:{distanceMillimeters:'1000000'}}],exerciseEvents:[{exerciseEventType:'PAUSE'}]}});},async()=>{
    const r=(await call('get_workout_details',{record_id:'run-1'})).structured as any;
    assert.equal(r.laps[0].distance_km,1);assert.equal(r.laps[0].pace_minutes_per_km,5);assert.equal(r.exercise.exerciseEvents[0].exerciseEventType,'PAUSE');
    await assert.rejects(call('get_workout_details',{record_id:'../../identity'}));
  });
});
test('TCX uses media export and explicit GPS policy; rejects invalid or oversize content',async()=>{
  await mock(url=>{assert.equal(url.searchParams.get('alt'),'media');assert.equal(url.searchParams.get('partialData'),'true');return new Response('<TrainingCenterDatabase></TrainingCenterDatabase>');},async()=>{
    const r=await call('export_workout_tcx',{record_id:'123',include_without_gps:true});assert.match(r.text,/TrainingCenterDatabase/);assert.equal(r.structured,undefined);
  });
  for(const text of ['{}','<TrainingCenterDatabase>'+ 'x'.repeat(1_000_001)])await mock(()=>new Response(text),async()=>{await assert.rejects(call('export_workout_tcx',{record_id:'123'}));});
});
test('device inventory preserves zero battery, pagination and sync time without MAC/account identifiers',async()=>{
  await mock(url=>{assert.equal(url.pathname,'/v4/users/me/pairedDevices');return json({pairedDevices:[{name:'users/private/pairedDevices/watch',macAddress:'private-mac',batteryLevel:0,lastSyncTime:'2026-10-20T00:00:00Z'}],nextPageToken:'next'});},async()=>{
    const r=await call('get_health_devices',{page_token:null});assert.equal((r.structured as any).devices[0].battery_level,0);assert.equal(r.structured?.next_page_token,'next');assert.ok(!r.text.includes('private'));
  });
});
test('optional permission failures stay errors and never become empty health records',async()=>{
  await mock(()=>json({error:{message:'Insufficient authentication scopes'}},403),async()=>{
    for(const [name,args] of [['get_health_devices',{}],['get_health_account',{resource:'settings'}],['query_health_data',{data_type:'electrocardiogram'}]] as const)await assert.rejects(call(name,args),/scope/i);
  });
});
test('writes are absent by default and a read grant cannot preview or create writes',async()=>{
  assert.ok(!buildTools(env).some(t=>t.name==='log_health_record'));
  await assert.rejects(call('log_health_record',{data_type:'hydration-log',record_json:JSON.stringify(hydration),confirm:true},{...env,ENABLE_WRITES:'1'}),/health:write/);
});
test('confirmed log writes exactly once and local preview does not access upstream',async()=>{
  let count=0;const e={...env,ENABLE_WRITES:'1'};
  await mock((url,body)=>{count++;assert.equal(url.pathname,'/v4/users/me/dataTypes/hydration-log/dataPoints');assert.deepEqual(body,{hydrationLog:{...hydration,interval:{...hydration.interval,startUtcOffset:'32400s',endUtcOffset:'32400s'}}});return json({done:true,response:{name:'test-record'}});},async()=>{
    const preview=await call('log_health_record',{data_type:'hydration-log',record_json:JSON.stringify(hydration),confirm:false},e,['health:write']);assert.equal(count,0);assert.equal(preview.structured?.preview,true);
    const written=await call('log_health_record',{data_type:'hydration-log',record_json:JSON.stringify(hydration),confirm:true},e,['health:write']);assert.equal(count,1);assert.equal(written.structured?.completed,true);
  });
});
test('all writable payload families validate and reject injected ownership, invalid times and amounts',()=>{
  const when={physicalTime:'2026-10-20T10:00:00Z'};
  for(const [type,payload] of Object.entries({
    'hydration-log':hydration,'nutrition-log':{interval:hydration.interval,foodDisplayName:'Rice',energy:{kcal:200},mealType:'LUNCH',nutrients:[{nutrient:'PROTEIN',quantity:{grams:4}}]},
    moods:{sampleTime:when,moods:['HAPPY']},symptoms:{sampleTime:when,symptoms:['HEADACHE']},'menstrual-period':{interval:hydration.interval,notes:'test'},
  }))assert.ok(validateRecord(type,JSON.stringify(payload)));
  for(const payload of [{...hydration,name:'users/other'}, {...hydration,amountConsumed:{milliliters:-1}}, {...hydration,interval:{startTime:'2026-02-30T00:00:00Z',endTime:'2026-03-01T00:00:00Z'}}])assert.throws(()=>validateRecord('hydration-log',JSON.stringify(payload)));
  assert.throws(()=>validateRecord('moods',JSON.stringify({sampleTime:when,moods:['NOT_REAL']})));
});
test('new optional catalog entries retain correct scope and unsupported filter boundaries',async()=>{
  const r=(await call('list_health_data_types',{})).structured as any;assert.equal(r.data_types.length,38);
  const ecg=r.data_types.find((t:any)=>t.id==='electrocardiogram');assert.match(ecg.scope,/ecg.readonly$/);assert.equal(ecg.filterField.civil,null);
  await mock(()=>{throw new Error('unexpected request');},async()=>{await assert.rejects(call('query_health_data',{data_type:'electrocardiogram',start_date:'2026-10-20'}),/filter/);});
});
test('nutrition summary converts recorded macros/hydration and distinguishes absent records from zero',async()=>{
  await mock(url=>{
    const interval={startTime:'2026-10-20T10:00:00Z',endTime:'2026-10-20T10:00:00Z'};
    return url.pathname.includes('hydration-log')?json({dataPoints:[{hydrationLog:{interval,amountConsumed:{milliliters:250}}}]}):json({dataPoints:[{nutritionLog:{interval,energy:{kcal:200},totalFat:{grams:0},nutrients:[{nutrient:'PROTEIN',quantity:{grams:10}}]}}]});
  },async()=>{
    const r=(await call('get_nutrition_summary',{start_date:'2026-10-20',end_date:'2026-10-21'})).structured as any;
    assert.equal(r.days[0].kcal,200);assert.equal(r.days[0].fat_grams,0);assert.equal(r.days[0].protein_grams,10);assert.equal(r.days[0].water_ml,250);assert.equal(r.days[1].kcal,null);
  });
});

test('food without known calories stays unspecified and local timestamps retain the civil offset',()=>{
 const payload=validateRecord('nutrition-log',JSON.stringify({interval:hydration.interval,foodDisplayName:'Lunch'}));
 assert.equal(payload.energy,undefined);assert.equal(payload.interval.startUtcOffset,'32400s');
 assert.throws(()=>validateRecord('nutrition-log',JSON.stringify({...payload,nutrients:[{nutrient:'MADE_UP',quantity:{grams:1}}]})));
 assert.throws(()=>validateRecord('nutrition-log',JSON.stringify({...payload,interval:{...payload.interval,startUtcOffset:'oops'}})));
});
