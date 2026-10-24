/**
 * Fixture data for UI and tests. NOT verified travel information:
 * place names are real, but coordinates, hours, times and prices are illustrative only.
 * Every record carries dataStatus 'fixture' so screens can label it as mock data.
 */
import type {
  Activity,
  CandidateBlueprint,
  Feed,
  JobStatus,
  PlaceInfo,
  PlanBlueprint,
  Provenance,
  TravelLeg,
  Trip,
} from '@tkb/contracts';

export const FIXTURE_NOTICE = 'サンプルデータ（fixture）です。実在の時刻・料金・営業時間ではありません。';

const provenance: Provenance = {
  source: 'fixture',
  fetchedAt: null,
  attribution: 'tkb_2627 fixture',
  maySendToModel: true,
  mayStore: true,
  mayExport: true,
  retainUntil: null,
};

function place(placeId: string, name: string, kind: PlaceInfo['kind'], lat: number, lng: number, timeZone: string, extra: Partial<PlaceInfo> = {}): PlaceInfo {
  return {
    placeId,
    name,
    kind,
    location: { lat, lng },
    timeZone,
    openingHours: null,
    description: null,
    photo: null,
    dataStatus: 'fixture',
    provenance,
    ...extra,
  };
}

function activity(activityId: string, title: string, kind: Activity['kind'], timeZone: string, startUtc: string | null, endUtc: string | null, extra: Partial<Activity> = {}): Activity {
  return {
    type: 'activity',
    activityId,
    kind,
    title,
    placeId: null,
    areaName: null,
    start: startUtc ? { utc: startUtc, timeZone } : null,
    end: endUtc ? { utc: endUtc, timeZone } : null,
    fixed: false,
    status: 'planned',
    cost: null,
    privateNotes: null,
    ...extra,
  };
}

function leg(legId: string, fromPlaceId: string, toPlaceId: string, mode: TravelLeg['mode'], timeZone: string, depUtc: string | null, arrUtc: string | null, extra: Partial<TravelLeg> = {}): TravelLeg {
  const durationSeconds = depUtc && arrUtc ? (Date.parse(arrUtc) - Date.parse(depUtc)) / 1000 : null;
  return {
    type: 'leg',
    legId,
    mode,
    fromPlaceId,
    toPlaceId,
    departure: depUtc ? { utc: depUtc, timeZone } : null,
    arrival: arrUtc ? { utc: arrUtc, timeZone } : null,
    durationSeconds,
    lineName: null,
    platform: null,
    transfers: null,
    fare: null,
    dataStatus: 'fixture',
    provenance,
    ...extra,
  };
}

// ---------- Domestic: Kanazawa, public transit, JPY ----------
const JST = 'Asia/Tokyo';
export const kanazawaPlaces: PlaceInfo[] = [
  place('fx_kanazawa_station', '金沢駅', 'station', 36.578, 136.648, JST),
  place('fx_kenrokuen', '兼六園', 'spot', 36.562, 136.662, JST, { openingHours: '（fixture）7:00-18:00', description: '（fixture）日本三名園の一つとされる庭園。' }),
  place('fx_21c_museum', '金沢21世紀美術館', 'spot', 36.561, 136.658, JST, { openingHours: null }),
  place('fx_omicho', '近江町市場', 'area', 36.571, 136.656, JST),
  place('fx_higashi', 'ひがし茶屋街', 'area', 36.572, 136.666, JST),
  place('fx_sushi', '（fixture）寿司店A', 'restaurant', 36.570, 136.657, JST),
];

export const domesticTrip: Trip = {
  schemaVersion: 1,
  tripId: 'fx_trip_kanazawa',
  ownerId: 'fx_user_a',
  title: '金沢 1泊2日（fixture）',
  revision: 1,
  constraints: {
    area: '金沢',
    startDate: '2026-11-01',
    endDate: '2026-11-02',
    timeZone: JST,
    transportMode: 'transit',
    budget: { amountMinor: 30000, currency: 'JPY' },
    mustVisit: ['fx_kenrokuen'],
  },
  days: [
    {
      date: '2026-11-01',
      timeZone: JST,
      items: [
        leg('fx_leg_1', 'fx_kanazawa_station', 'fx_kenrokuen', 'transit', JST, '2026-11-01T00:30:00Z', '2026-11-01T00:50:00Z', {
          lineName: '（fixture）路線バス',
          fare: { amountMinor: 200, currency: 'JPY' },
        }),
        activity('fx_act_kenrokuen', '兼六園を散策', 'visit', JST, '2026-11-01T01:00:00Z', '2026-11-01T02:30:00Z', {
          placeId: 'fx_kenrokuen',
          cost: { amountMinor: 320, currency: 'JPY' },
        }),
        leg('fx_leg_2', 'fx_kenrokuen', 'fx_21c_museum', 'walk', JST, '2026-11-01T02:30:00Z', '2026-11-01T02:45:00Z'),
        activity('fx_act_museum', '金沢21世紀美術館', 'visit', JST, '2026-11-01T02:45:00Z', '2026-11-01T04:15:00Z', {
          placeId: 'fx_21c_museum',
          // Admission unknown in fixture: stays null, never 0.
        }),
        leg('fx_leg_3', 'fx_21c_museum', 'fx_sushi', 'transit', JST, '2026-11-01T04:20:00Z', null, {
          dataStatus: 'unknown',
          provenance: null,
        }),
        activity('fx_act_lunch', '寿司店Aで昼食（予約済み）', 'meal', JST, '2026-11-01T04:30:00Z', '2026-11-01T05:30:00Z', {
          placeId: 'fx_sushi',
          fixed: true,
          cost: { amountMinor: 4000, currency: 'JPY' },
          privateNotes: '予約番号は非公開メモ（fixture）',
        }),
        activity('fx_act_omicho', '近江町市場で食べ歩き', 'free_walk', JST, '2026-11-01T06:00:00Z', '2026-11-01T07:00:00Z', {
          areaName: '近江町市場周辺',
          placeId: 'fx_omicho',
        }),
      ],
    },
    {
      date: '2026-11-02',
      timeZone: JST,
      items: [
        activity('fx_act_higashi', 'ひがし茶屋街を散策', 'free_walk', JST, '2026-11-02T01:00:00Z', '2026-11-02T03:00:00Z', {
          areaName: 'ひがし茶屋街',
          placeId: 'fx_higashi',
        }),
      ],
    },
  ],
  places: kanazawaPlaces,
  validationState: 'needs_review',
  warnings: ['fx_leg_3 の移動時間と運賃は未取得です'],
  createdAt: '2026-10-24T00:00:00Z',
  updatedAt: '2026-10-24T00:00:00Z',
};

// ---------- Overseas: Paris, crosses the end of DST (2026-10-25 03:00 CEST -> 02:00 CET), EUR ----------
const PARIS = 'Europe/Paris';
export const parisPlaces: PlaceInfo[] = [
  place('fx_louvre', 'Musée du Louvre', 'spot', 48.861, 2.336, PARIS),
  place('fx_orsay', "Musée d'Orsay", 'spot', 48.86, 2.326, PARIS),
  place('fx_marais', 'Le Marais', 'area', 48.859, 2.362, PARIS),
  place('fx_eiffel', 'Tour Eiffel', 'spot', 48.858, 2.294, PARIS),
];

export const overseasTrip: Trip = {
  schemaVersion: 1,
  tripId: 'fx_trip_paris',
  ownerId: 'fx_user_a',
  title: 'パリ 2日間（fixture・夏時間終了をまたぐ）',
  revision: 1,
  constraints: {
    area: 'Paris',
    startDate: '2026-10-24',
    endDate: '2026-10-25',
    timeZone: PARIS,
    transportMode: 'transit',
    budget: null,
  },
  days: [
    {
      date: '2026-10-24',
      timeZone: PARIS,
      items: [
        // 10:00 CEST = 08:00Z
        activity('fx_act_louvre', 'ルーヴル美術館（日時指定券）', 'visit', PARIS, '2026-10-24T08:00:00Z', '2026-10-24T11:00:00Z', {
          placeId: 'fx_louvre',
          fixed: true,
          cost: { amountMinor: 2200, currency: 'EUR' },
        }),
        leg('fx_leg_p1', 'fx_louvre', 'fx_marais', 'transit', PARIS, '2026-10-24T11:15:00Z', '2026-10-24T11:35:00Z', {
          lineName: '（fixture）Métro',
          fare: null,
        }),
        activity('fx_act_marais', 'マレ地区を自由散策', 'free_walk', PARIS, '2026-10-24T11:40:00Z', '2026-10-24T14:00:00Z', {
          areaName: 'Le Marais',
          placeId: 'fx_marais',
        }),
      ],
    },
    {
      date: '2026-10-25',
      timeZone: PARIS,
      items: [
        // 10:00 CET = 09:00Z (after DST ended at 01:00Z)
        activity('fx_act_orsay', 'オルセー美術館', 'visit', PARIS, '2026-10-25T09:00:00Z', '2026-10-25T11:00:00Z', {
          placeId: 'fx_orsay',
        }),
        leg('fx_leg_p2', 'fx_orsay', 'fx_eiffel', 'car', PARIS, '2026-10-25T11:10:00Z', '2026-10-25T11:30:00Z'),
        activity('fx_act_eiffel', 'エッフェル塔', 'visit', PARIS, '2026-10-25T11:30:00Z', '2026-10-25T13:00:00Z', {
          placeId: 'fx_eiffel',
        }),
      ],
    },
  ],
  places: parisPlaces,
  validationState: 'needs_review',
  warnings: ['運賃が未取得の区間があります'],
  createdAt: '2026-10-24T00:00:00Z',
  updatedAt: '2026-10-24T00:00:00Z',
};

export const fixtureTrips: Trip[] = [domesticTrip, overseasTrip];

// ---------- AI / job samples (K02, K03) ----------
const candidates: CandidateBlueprint[] = [
  {
    candidateId: 'candidate_1',
    title: '庭園と美術館を優先',
    activityOrder: ['fx_kenrokuen', 'fx_21c_museum', 'fx_omicho'],
    reasons: ['必須地点の兼六園を午前に配置'],
    warnings: [],
  },
  {
    candidateId: 'candidate_2',
    title: '茶屋街を優先',
    activityOrder: ['fx_kenrokuen', 'fx_higashi'],
    excludedPlaceIds: ['fx_21c_museum'],
    reasons: ['移動を減らすため美術館を除外'],
    warnings: ['美術館の開館時間は未取得'],
  },
];
export const samplePlanBlueprint: PlanBlueprint = { schemaVersion: 1, candidates };

export const sampleJobStatuses: Record<'queued' | 'running' | 'succeeded' | 'failed', JobStatus> = {
  queued: { jobId: 'fx_job_1', state: 'queued', stage: 'queued', batchId: null, error: null, updatedAt: '2026-10-24T00:00:00Z' },
  running: { jobId: 'fx_job_1', state: 'running', stage: 'generating', batchId: null, error: null, updatedAt: '2026-10-24T00:00:05Z' },
  succeeded: { jobId: 'fx_job_1', state: 'succeeded', stage: 'saved', batchId: 'fx_batch_1', error: null, updatedAt: '2026-10-24T00:00:30Z' },
  failed: {
    jobId: 'fx_job_2',
    state: 'failed',
    stage: 'generating',
    batchId: null,
    error: { code: 'CLI_TIMEOUT', message: '生成が時間内に終わりませんでした。', retryable: true, requestId: 'req_fx_1' },
    updatedAt: '2026-10-24T00:02:00Z',
  },
};

// ---------- SNS sample (K14) ----------
export const sampleFeed: Feed = {
  items: [
    {
      postId: 'fx_post_1',
      postRevision: 1,
      authorDisplayName: 'デモ利用者A',
      title: domesticTrip.title,
      story: '金沢の旅行記録（fixture）',
      visibility: 'public',
      groupId: null,
      area: '金沢',
      startDate: '2026-11-01',
      createdAt: '2026-10-24T00:00:00Z',
    },
  ],
  nextCursor: null,
};
