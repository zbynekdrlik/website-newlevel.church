type RegistrationContact = {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
};

export function buildRegistrationUrl(contact: RegistrationContact) {
  const params = new URLSearchParams();

  if (contact.name?.trim()) params.set("name", contact.name.trim());
  if (contact.email?.trim()) params.set("email", contact.email.trim());
  if (contact.phone?.trim()) params.set("phone", contact.phone.trim());

  const query = params.toString();
  return `https://newlevel.church/youth/#registracia${
    query ? `?${query}` : ""
  }`;
}
