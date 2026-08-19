export const REGISTRATION_URL =
  "https://www.newlevel.church/youth/#registracia";

type RegistrationContact = {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
};

export function buildRegistrationUrl(_contact?: RegistrationContact) {
  return REGISTRATION_URL;
}
