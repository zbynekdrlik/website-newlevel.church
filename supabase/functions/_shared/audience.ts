export type AudienceType =
  | "all_with_phone"
  | "registered_for_event"
  | "not_registered_for_event"
  | "previously_registered_not_registered"
  | "custom_selection";

type RegistrationState = {
  registeredForSelected: boolean;
  everRegistered: boolean;
};

export function audienceMatches(
  audienceType: AudienceType,
  state: RegistrationState,
) {
  switch (audienceType) {
    case "all_with_phone":
    case "custom_selection":
      return true;
    case "registered_for_event":
      return state.registeredForSelected;
    case "not_registered_for_event":
      return !state.registeredForSelected;
    case "previously_registered_not_registered":
      return state.everRegistered && !state.registeredForSelected;
  }
}
