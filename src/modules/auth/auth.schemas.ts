import { z } from "zod";

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const password = z.string().min(8).max(72);
const name = z.string().trim().min(2).max(100);

export const registerSchema = z
  .object({
    name,
    email,
    password,
    passwordConfirmation: z.string(),
  })
  .strict()
  .refine((value) => value.password === value.passwordConfirmation, {
    message: "Passwords do not match.",
    path: ["passwordConfirmation"],
  });

export const loginSchema = z
  .object({
    email,
    password: z.string().max(72),
  })
  .strict();

export const updateProfileSchema = z.object({ name }).strict();

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().max(72),
    newPassword: password,
    passwordConfirmation: z.string(),
  })
  .strict()
  .refine((value) => value.newPassword === value.passwordConfirmation, {
    message: "Passwords do not match.",
    path: ["passwordConfirmation"],
  });

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
