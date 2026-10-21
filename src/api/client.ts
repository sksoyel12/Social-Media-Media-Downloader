import { useMutation, useQuery, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import type {
  DownloadFileInput,
  DownloadInput,
  DownloadResult,
  HealthStatus,
  HighlightInput,
  HighlightResult,
} from "../types/api";

export async function checkHealth(): Promise<HealthStatus> {
  const res = await fetch("/api/healthz");
  if (!res.ok) {
    throw new Error("Health check failed");
  }
  return res.json();
}

export function useHealthCheck(): UseQueryResult<HealthStatus, Error> {
  return useQuery({
    queryKey: ["healthz"],
    queryFn: checkHealth,
    refetchInterval: 30000,
    retry: 2,
  });
}

export async function extractMedia(input: DownloadInput): Promise<DownloadResult> {
  const res = await fetch("/api/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.error || "The service could not prepare this download. Please try again.");
  }

  return res.json();
}

export function useExtractMedia(): UseMutationResult<DownloadResult, Error, { data: DownloadInput }> {
  return useMutation({
    mutationFn: async ({ data }) => extractMedia(data),
  });
}

export async function downloadHighlight(input: HighlightInput): Promise<HighlightResult> {
  const res = await fetch("/api/highlight", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.error || "Could not retrieve stories for this highlight.");
  }

  return res.json();
}

export function useDownloadHighlight(): UseMutationResult<HighlightResult, Error, { data: HighlightInput }> {
  return useMutation({
    mutationFn: async ({ data }) => downloadHighlight(data),
  });
}

export async function downloadFile(input: DownloadFileInput): Promise<Blob> {
  const res = await fetch("/api/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.error || "Failed to download media item.");
  }

  return res.blob();
}

export function useDownloadFile(): UseMutationResult<Blob, Error, { data: DownloadFileInput }> {
  return useMutation({
    mutationFn: async ({ data }) => downloadFile(data),
  });
}
