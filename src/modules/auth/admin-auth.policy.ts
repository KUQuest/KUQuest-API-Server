const adminPasswordPattern =
  /^(?=.{8,25}$)(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E])[\x21-\x7E]+$/;

export const isValidAdminPassword = (password: string): boolean =>
  adminPasswordPattern.test(password);
