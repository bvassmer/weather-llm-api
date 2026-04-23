export const ALERT_SOURCE_FAMILIES = ["nws", "spc", "wpc", "airnow"] as const;

export type AlertSourceFamily = (typeof ALERT_SOURCE_FAMILIES)[number];

export interface AlertSourceMetadata {
  sourceFamily: AlertSourceFamily;
  sourceProduct: string;
}

const SPC_CONVECTIVE_OUTLOOK_PREFIX = "SPC Convective Outlook Day ";
const SPC_FIRE_WEATHER_OUTLOOK_PREFIX = "SPC Fire Weather Outlook Day ";
const AIRNOW_OBS_PREFIX = "airnow-obs|";
const AIRNOW_FORECAST_PREFIX = "airnow-fx|";
const WPC_SNOW_PREFIX = "WPC_SNOW_";

const normalizeOptionalString = (
  value: string | null | undefined,
): string | undefined => {
  const trimmed = value?.trim();
  return trimmed?.length ? trimmed : undefined;
};

export const normalizeAlertSourceFamily = (
  value: string | null | undefined,
): AlertSourceFamily | undefined => {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if ((ALERT_SOURCE_FAMILIES as readonly string[]).includes(normalized)) {
    return normalized as AlertSourceFamily;
  }

  return undefined;
};

export const resolveAlertSourceMetadata = (input: {
  sourceFamily?: string | null;
  sourceProduct?: string | null;
  nwsId?: string | null;
  event?: string | null;
}): AlertSourceMetadata => {
  const explicitFamily = normalizeAlertSourceFamily(input.sourceFamily);
  const explicitProduct = normalizeOptionalString(input.sourceProduct);
  const nwsId = normalizeOptionalString(input.nwsId);
  const event = normalizeOptionalString(input.event);

  let inferredFamily: AlertSourceFamily = "nws";
  let inferredProduct = "active-alert";

  if (
    nwsId?.startsWith(AIRNOW_OBS_PREFIX) ||
    event === "AirNow AQI Threshold Alert"
  ) {
    inferredFamily = "airnow";
    inferredProduct = "aqi-threshold-alert";
  } else if (
    nwsId?.startsWith(AIRNOW_FORECAST_PREFIX) ||
    event === "AirNow AQI Forecast Alert"
  ) {
    inferredFamily = "airnow";
    inferredProduct = "aqi-forecast-alert";
  } else if (
    event === "SPC Mesoscale Discussion" ||
    nwsId?.includes("MESOSCALE_DISCUSSION")
  ) {
    inferredFamily = "spc";
    inferredProduct = "mesoscale-discussion";
  } else if (event?.startsWith(SPC_CONVECTIVE_OUTLOOK_PREFIX)) {
    inferredFamily = "spc";
    inferredProduct = "convective-outlook";
  } else if (event?.startsWith(SPC_FIRE_WEATHER_OUTLOOK_PREFIX)) {
    inferredFamily = "spc";
    inferredProduct = "fire-weather-outlook";
  } else if (event === "WPC Excessive Rainfall") {
    inferredFamily = "wpc";
    inferredProduct = "excessive-rainfall";
  } else if (
    event === "WPC Snow Forecast" ||
    nwsId?.startsWith(WPC_SNOW_PREFIX)
  ) {
    inferredFamily = "wpc";
    inferredProduct = "snow-forecast";
  }

  return {
    sourceFamily: explicitFamily ?? inferredFamily,
    sourceProduct: explicitProduct ?? inferredProduct,
  };
};

export const readAlertCollectionsFromEnv = (
  env: NodeJS.ProcessEnv,
): Record<AlertSourceFamily, string> => {
  const legacyDefault =
    normalizeOptionalString(env.QDRANT_COLLECTION_NWS_ALERTS) ??
    "nws_alerts_embeddings_v1";

  return {
    nws:
      normalizeOptionalString(env.QDRANT_COLLECTION_NWS_ALERTS_NWS) ??
      "nws_alerts_embeddings_nws_v1",
    spc:
      normalizeOptionalString(env.QDRANT_COLLECTION_NWS_ALERTS_SPC) ??
      "nws_alerts_embeddings_spc_v1",
    wpc:
      normalizeOptionalString(env.QDRANT_COLLECTION_NWS_ALERTS_WPC) ??
      "nws_alerts_embeddings_wpc_v1",
    airnow:
      normalizeOptionalString(env.QDRANT_COLLECTION_NWS_ALERTS_AIRNOW) ??
      (legacyDefault === "nws_alerts_embeddings_v1"
        ? "nws_alerts_embeddings_airnow_v1"
        : `${legacyDefault}_airnow`),
  };
};

export const resolveAlertCollectionName = (
  sourceFamily: string | null | undefined,
  collections: Record<AlertSourceFamily, string>,
): string => {
  const family = normalizeAlertSourceFamily(sourceFamily) ?? "nws";
  return collections[family];
};

export const resolveAlertCollectionNames = (
  sourceFamily: string | null | undefined,
  collections: Record<AlertSourceFamily, string>,
): string[] => {
  const family = normalizeAlertSourceFamily(sourceFamily);
  if (family) {
    return [collections[family]];
  }

  return [...new Set(ALERT_SOURCE_FAMILIES.map((item) => collections[item]))];
};
