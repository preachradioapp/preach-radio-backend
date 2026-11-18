import { z } from 'zod';

// validateRequest parses `{ body, cookies }`, so fields must sit under `body`
// (the previous unwrapped schema validated nothing).
export const updateSuperAdminSchema = z.object({
    body: z.object({
        name: z
            .string()
            .trim()
            .min(1, 'Name cannot be empty')
            .max(80)
            .optional(),
        phone: z.string().trim().max(30).optional(),
        email: z.string().email('Invalid email format').optional(),
    }),
});

const superAdminValidations = {
    updateSuperAdminSchema,
};

export default superAdminValidations;
