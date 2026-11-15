import { useSettings } from "@getpaseo/plugin/client";
import { allowedTypes, BUILTIN_TYPES, memorySettings } from "../shared/memory";

// The types that may be chosen for a memory now. Until settings load, or while they are invalid,
// only the built-in ones, which is also what the daemon allows then.
export function useAllowedTypes(): readonly string[] {
  const settings = useSettings(memorySettings);
  return settings.status === "ready" ? allowedTypes(settings.values.customTypes) : BUILTIN_TYPES;
}
