import { create30ABeachAdapter } from "./adapters/30abeach";
import { create30AEscapesAdapter } from "./adapters/30aescapes";
import { create30ALuxuryAdapter } from "./adapters/30aluxury";
import { createThirtyAVacayAdapter } from "./adapters/30avacay";
import { create360BlueAdapter } from "./adapters/360blue";
import { createBeachBlueAdapter } from "./adapters/beachblue";
import { createBenchmark30AAdapter } from "./adapters/benchmark30a";
import { createCoastProperties30AAdapter } from "./adapters/coastproperties30a";
import { createDuneVR30AAdapter } from "./adapters/dunevr30a";
import { createExclusive30AAdapter } from "./adapters/exclusive30a";
import { createFiveStar30AAdapter } from "./adapters/fivestar30a";
import { createFunVacay30AAdapter } from "./adapters/funvacay30a";
import { createGrayt30AAdapter } from "./adapters/grayt30a";
import { createHomeownersCollection30AAdapter } from "./adapters/homeownerscollection30a";
import { createKeyco30AAdapter } from "./adapters/keyco30a";
import { createLocalVR30AAdapter } from "./adapters/localvr30a";
import { createLuxe30AAdapter } from "./adapters/luxe30a";
import { createOceanReef30AAdapter } from "./adapters/oceanreef30a";
import { createOversee30AAdapter } from "./adapters/oversee30a";
import { createPanhandle30AAdapter } from "./adapters/panhandle30a";
import { createRealJoy30AAdapter } from "./adapters/realjoy30a";
import { createRoyalDestinationsAdapter } from "./adapters/royaldestinations";
import { createSandersBeach30AAdapter } from "./adapters/sandersbeach30a";
import { createSandpiper30AAdapter } from "./adapters/sandpiper30a";
import { createScenicStays30AAdapter } from "./adapters/scenicstays30a";
import { createStayAt30AAdapter } from "./adapters/stayat30a";
import { createStayOn30AAdapter } from "./adapters/stayon30a";
import type { DetailRecordBase, ScraperAdapter } from "./types";

type AdapterFactory = () => ScraperAdapter<DetailRecordBase>;

const ADAPTER_FACTORIES: Record<string, AdapterFactory> = {
  "30abeach": create30ABeachAdapter,
  "30aescapes": create30AEscapesAdapter,
  "30aluxury": create30ALuxuryAdapter,
  "30avacay": createThirtyAVacayAdapter,
  "360blue": create360BlueAdapter,
  beachblue: createBeachBlueAdapter,
  benchmark30a: createBenchmark30AAdapter,
  coastproperties30a: createCoastProperties30AAdapter,
  dunevr30a: createDuneVR30AAdapter,
  exclusive30a: createExclusive30AAdapter,
  fivestar30a: createFiveStar30AAdapter,
  funvacay30a: createFunVacay30AAdapter,
  grayt30a: createGrayt30AAdapter,
  homeownerscollection30a: createHomeownersCollection30AAdapter,
  keyco30a: createKeyco30AAdapter,
  localvr30a: createLocalVR30AAdapter,
  luxe30a: createLuxe30AAdapter,
  oceanreef30a: createOceanReef30AAdapter,
  oversee30a: createOversee30AAdapter,
  panhandle30a: createPanhandle30AAdapter,
  realjoy30a: createRealJoy30AAdapter,
  royaldestinations: createRoyalDestinationsAdapter,
  sandersbeach30a: createSandersBeach30AAdapter,
  sandpiper30a: createSandpiper30AAdapter,
  scenicstays30a: createScenicStays30AAdapter,
  stayat30a: createStayAt30AAdapter,
  stayon30a: createStayOn30AAdapter,
};

export function getKnownAdapterKeys(): string[] {
  return Object.keys(ADAPTER_FACTORIES).sort();
}

export function createAdapterByKey(
  adapterKey: string,
): ScraperAdapter<DetailRecordBase> | null {
  const key = adapterKey.trim().toLowerCase();
  const factory = ADAPTER_FACTORIES[key];
  if (!factory) {
    return null;
  }
  return factory();
}
