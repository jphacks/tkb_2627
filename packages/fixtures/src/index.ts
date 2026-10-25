/**
 * Fixture data for UI and tests. NOT verified travel information:
 * place names are real, but coordinates, hours, times and prices are illustrative only.
 * Every place and leg carries dataStatus 'fixture' (activity costs carry costStatus) so screens can label it as mock data.
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
    costStatus: extra.costStatus ?? (extra.cost ? 'fixture' : 'unknown'),
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

// ---------- Domestic: Kanazawa, public transit + walking, JPY (dense 2-day sample) ----------
const JST = 'Asia/Tokyo';

/** "2026-11-01" + "09:30" (JST, UTC+9, no DST) -> UTC instant string. */
export function jst(date: string, hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const base = Date.parse(`${date}T00:00:00Z`) + (h * 60 + m) * 60_000 - 9 * 3_600_000;
  return new Date(base).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
/** Exported builders so other fixture files (cases.ts) can assemble extra items in the same shape. */
export const fxActivity = activity;
export const fxLeg = leg;

// The six places the area-level fixtures (K05 area pool, place search, guides, generation tests) have always used.
export const kanazawaPlaces: PlaceInfo[] = [
  place('fx_kanazawa_station', '金沢駅', 'station', 36.578, 136.648, JST),
  place('fx_kenrokuen', '兼六園', 'spot', 36.562, 136.662, JST, { openingHours: '（fixture）7:00-18:00', description: '（fixture）日本三名園の一つとされる庭園。' }),
  place('fx_21c_museum', '金沢21世紀美術館', 'spot', 36.561, 136.658, JST, { openingHours: null }),
  place('fx_omicho', '近江町市場', 'area', 36.571, 136.656, JST),
  place('fx_higashi', 'ひがし茶屋街', 'area', 36.572, 136.666, JST),
  place('fx_sushi', '（fixture）寿司店A', 'restaurant', 36.570, 136.657, JST),
];

// Additional places the dense sample trip visits. Not part of the area pool above.
const kanazawaExtraPlaces: PlaceInfo[] = [
  place('fx_kanazawa_castle', '金沢城公園', 'spot', 36.5655, 136.6594, JST, { openingHours: null }),
  place('fx_korinbo', '香林坊', 'area', 36.5604, 136.6540, JST),
  place('fx_dinner', '（fixture）香林坊の夕食店', 'restaurant', 36.5606, 136.6547, JST),
  place('fx_hotel', '（fixture）ホテル', 'lodging', 36.5700, 136.6520, JST),
  place('fx_kazue', '主計町茶屋街', 'area', 36.5739, 136.6639, JST),
  place('fx_oyama', '尾山神社', 'spot', 36.5667, 136.6588, JST),
  place('fx_nagamachi', '長町武家屋敷跡', 'spot', 36.5638, 136.6516, JST),
  // Day 2 packed until the evening (UI review on #33: the sample fitted in about one day).
  place('fx_lunch2', '（fixture）香林坊のランチ店', 'restaurant', 36.5612, 136.6558, JST),
  place('fx_nishi', 'にし茶屋街', 'area', 36.5577, 136.6493, JST),
  place('fx_myoryuji', '妙立寺', 'spot', 36.5562, 136.6507, JST),
  // The stop the bus to the hotel stops at: a spot of its own between the dinner and the hotel (UI review on #34).
  place('fx_stop_musashi', '武蔵ヶ辻・近江町市場（バス停）', 'station', 36.5713, 136.6561, JST),
];
export const kanazawaTripPlaces: PlaceInfo[] = [...kanazawaPlaces, ...kanazawaExtraPlaces];

const D1 = '2026-11-01';
const D2 = '2026-11-02';
const t = (d: string, hhmm: string) => jst(d, hhmm);
const yen = (amountMinor: number) => ({ amountMinor, currency: 'JPY' });

export const domesticTrip: Trip = {
  schemaVersion: 1,
  tripId: 'fx_trip_kanazawa',
  ownerId: 'fx_user_a',
  title: '金沢 1泊2日（fixture）',
  revision: 1,
  constraints: {
    area: '金沢',
    startDate: D1,
    endDate: D2,
    timeZone: JST,
    transportMode: 'transit',
    budget: { amountMinor: 30000, currency: 'JPY' },
    mustVisit: ['fx_kenrokuen'],
  },
  days: [
    {
      date: D1,
      timeZone: JST,
      items: [
        activity('fx_act_station', '金沢駅（出発）', 'custom', JST, t(D1, '09:00'), t(D1, '09:10'), { placeId: 'fx_kanazawa_station' }),
        // The arrival time of the bus is not known (fixture): null, never guessed.
        leg('fx_leg_k1', 'fx_kanazawa_station', 'fx_omicho', 'transit', JST, t(D1, '09:10'), null, {
          lineName: '（fixture）路線バス', fare: yen(210), dataStatus: 'unknown', provenance: null,
        }),
        activity('fx_act_omicho', '近江町市場エリア', 'free_walk', JST, t(D1, '09:30'), t(D1, '12:30'), {
          areaName: '近江町市場周辺', placeId: 'fx_omicho',
        }),
        activity('fx_act_omicho_walk', '市場を散策（買い物・見学）', 'free_walk', JST, t(D1, '09:30'), t(D1, '11:30'), {
          areaName: '近江町市場周辺', parentActivityId: 'fx_act_omicho',
        }),
        activity('fx_act_lunch', '寿司店Aで海鮮丼の昼食（予約済み）', 'meal', JST, t(D1, '11:30'), t(D1, '12:15'), {
          placeId: 'fx_sushi', fixed: true, cost: yen(2200), parentActivityId: 'fx_act_omicho',
          privateNotes: '予約番号は非公開メモ（fixture）',
        }),
        leg('fx_leg_k2', 'fx_omicho', 'fx_kanazawa_castle', 'walk', JST, t(D1, '12:30'), t(D1, '12:45')),
        activity('fx_act_castle', '金沢城公園', 'visit', JST, t(D1, '12:45'), t(D1, '14:00'), { placeId: 'fx_kanazawa_castle' }),
        leg('fx_leg_k3', 'fx_kanazawa_castle', 'fx_kenrokuen', 'walk', JST, t(D1, '14:00'), t(D1, '14:10')),
        activity('fx_act_kenrokuen', '兼六園を散策', 'visit', JST, t(D1, '14:10'), t(D1, '15:30'), {
          placeId: 'fx_kenrokuen', cost: yen(320),
        }),
        leg('fx_leg_k4', 'fx_kenrokuen', 'fx_21c_museum', 'walk', JST, t(D1, '15:30'), t(D1, '15:45')),
        activity('fx_act_museum', '金沢21世紀美術館', 'visit', JST, t(D1, '15:45'), t(D1, '17:15'), {
          placeId: 'fx_21c_museum',
          // Admission unknown in fixture: stays null, never 0.
        }),
        leg('fx_leg_k5', 'fx_21c_museum', 'fx_dinner', 'walk', JST, t(D1, '17:15'), t(D1, '17:25')),
        // Starts when the 10-minute walk arrives (UI review on #34: the times did not match the walk).
        activity('fx_act_dinner', '香林坊で夕食', 'meal', JST, t(D1, '17:25'), t(D1, '19:00'), { placeId: 'fx_dinner' }),
        leg('fx_leg_k6', 'fx_dinner', 'fx_stop_musashi', 'transit', JST, t(D1, '19:00'), t(D1, '19:15'), {
          lineName: '（fixture）路線バス', fare: yen(210),
          transit: { boardingStop: '（fixture）香林坊', alightingStop: '武蔵ヶ辻・近江町市場', transferStops: [] },
        }),
        // One minute to get off (a calendar event needs an end); the screens show a station with its start only.
        activity('fx_act_stop_musashi', '武蔵ヶ辻・近江町市場（バス停）', 'custom', JST, t(D1, '19:15'), t(D1, '19:16'), { placeId: 'fx_stop_musashi' }),
        leg('fx_leg_k6b', 'fx_stop_musashi', 'fx_hotel', 'walk', JST, t(D1, '19:16'), t(D1, '19:22')),
        activity('fx_act_hotel', 'ホテルにチェックイン', 'lodging', JST, t(D1, '19:22'), null, { placeId: 'fx_hotel' }),
      ],
    },
    {
      date: D2,
      timeZone: JST,
      items: [
        activity('fx_act_higashi', 'ひがし茶屋街', 'free_walk', JST, t(D2, '09:30'), t(D2, '11:30'), {
          areaName: 'ひがし茶屋街', placeId: 'fx_higashi',
        }),
        activity('fx_act_higashi_tea', '茶屋の見学', 'visit', JST, t(D2, '10:00'), t(D2, '10:45'), { parentActivityId: 'fx_act_higashi' }),
        activity('fx_act_higashi_sweets', '和菓子と休憩', 'custom', JST, t(D2, '10:45'), t(D2, '11:15'), { parentActivityId: 'fx_act_higashi' }),
        leg('fx_leg_k7', 'fx_higashi', 'fx_kazue', 'walk', JST, t(D2, '11:30'), t(D2, '11:35')),
        activity('fx_act_kazue', '主計町茶屋街を歩く', 'free_walk', JST, t(D2, '11:35'), t(D2, '12:15'), {
          areaName: '主計町茶屋街', placeId: 'fx_kazue',
        }),
        leg('fx_leg_k8', 'fx_kazue', 'fx_oyama', 'walk', JST, t(D2, '12:15'), t(D2, '12:35')),
        activity('fx_act_oyama', '尾山神社', 'visit', JST, t(D2, '12:35'), t(D2, '13:15'), { placeId: 'fx_oyama' }),
        leg('fx_leg_k9', 'fx_oyama', 'fx_lunch2', 'walk', JST, t(D2, '13:15'), t(D2, '13:25')),
        activity('fx_act_lunch2', '香林坊で昼食', 'meal', JST, t(D2, '13:25'), t(D2, '14:10'), { placeId: 'fx_lunch2' }),
        leg('fx_leg_k11', 'fx_lunch2', 'fx_nishi', 'walk', JST, t(D2, '14:10'), t(D2, '14:30')),
        // A visit, not a food walk, right after lunch (D06 meal_after_meal).
        activity('fx_act_nishi', 'にし茶屋街を見学', 'visit', JST, t(D2, '14:30'), t(D2, '15:15'), { areaName: 'にし茶屋街', placeId: 'fx_nishi' }),
        leg('fx_leg_k12', 'fx_nishi', 'fx_myoryuji', 'walk', JST, t(D2, '15:15'), t(D2, '15:20')),
        activity('fx_act_myoryuji', '妙立寺', 'visit', JST, t(D2, '15:20'), t(D2, '16:05'), { placeId: 'fx_myoryuji' }),
        leg('fx_leg_k13', 'fx_myoryuji', 'fx_nagamachi', 'walk', JST, t(D2, '16:05'), t(D2, '16:25')),
        activity('fx_act_nagamachi', '長町武家屋敷跡', 'visit', JST, t(D2, '16:25'), t(D2, '17:25'), { placeId: 'fx_nagamachi' }),
        leg('fx_leg_k10', 'fx_nagamachi', 'fx_kanazawa_station', 'transit', JST, t(D2, '17:25'), t(D2, '17:50'), {
          lineName: '（fixture）路線バス', fare: yen(210),
        }),
        activity('fx_act_station_end', '金沢駅（到着）', 'custom', JST, t(D2, '17:50'), null, { placeId: 'fx_kanazawa_station' }),
      ],
    },
  ],
  places: kanazawaTripPlaces,
  validationState: 'needs_review',
  warnings: ['fx_leg_k1 の到着時刻は未取得です', '美術館の入館料と各所の営業時間は未取得です'],
  createdAt: '2026-10-24T00:00:00Z',
  updatedAt: '2026-10-24T00:00:00Z',
};

/**
 * Route samples between the area pool places (kanazawaPlaces) (served by the fixture route provider next to the trip's own legs).
 * Sample data, not a timetable: station→garden by bus (20 min, fare 200), garden→museum on foot (15 min), museum→sushi
 * by transit with unknown time and fare (stays null, never 0).
 */
export const kanazawaRouteSamples: TravelLeg[] = [
  leg('fx_leg_1', 'fx_kanazawa_station', 'fx_kenrokuen', 'transit', JST, '2026-11-01T00:30:00Z', '2026-11-01T00:50:00Z', {
    lineName: '（fixture）路線バス',
    fare: { amountMinor: 200, currency: 'JPY' },
  }),
  leg('fx_leg_2', 'fx_kenrokuen', 'fx_21c_museum', 'walk', JST, '2026-11-01T02:30:00Z', '2026-11-01T02:45:00Z'),
  leg('fx_leg_3', 'fx_21c_museum', 'fx_sushi', 'transit', JST, '2026-11-01T04:20:00Z', null, { dataStatus: 'unknown', provenance: null }),
];

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
  succeeded: { jobId: 'fx_job_1', state: 'succeeded', stage: 'done', batchId: 'fx_batch_1', error: null, updatedAt: '2026-10-24T00:00:30Z' },
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

export * from './cases.ts';
