/**
 * Phone number validation utilities
 *
 * Validates phone numbers for WhatsApp JID format
 */

export interface ValidationResult {
    isValid: boolean;
    cleaned: string;
    error?: string;
}

/**
 * Validates and sanitizes a phone number for WhatsApp
 * @param number Raw phone number input
 * @returns Object with isValid flag and cleaned number
 */
export function validatePhoneNumber(number: string | null | undefined): ValidationResult {
    if (!number || typeof number !== 'string') {
        return { isValid: false, cleaned: '', error: 'Phone number is required' };
    }

    // Remove all non-digit characters
    const cleaned = number.replace(/\D/g, '');

    // WhatsApp requires phone numbers to be:
    // - At least 10 digits (minimum for valid phone numbers)
    // - Maximum 15 digits (E.164 standard)
    // - Must start with country code (no leading zeros for most countries)

    if (cleaned.length < 10) {
        return { isValid: false, cleaned, error: 'Phone number must be at least 10 digits' };
    }

    if (cleaned.length > 15) {
        return { isValid: false, cleaned, error: 'Phone number cannot exceed 15 digits (E.164 standard)' };
    }

    // Check for obviously invalid patterns
    // All zeros or all same digit
    if (/^(\d)\1{9,}$/.test(cleaned)) {
        return { isValid: false, cleaned, error: 'Invalid phone number pattern' };
    }

    return { isValid: true, cleaned };
}

/**
 * Creates a WhatsApp JID from a validated phone number
 * @param cleanedNumber Validated phone number (digits only)
 * @returns WhatsApp JID string
 */
export function createWhatsAppJid(cleanedNumber: string): string {
    return `${cleanedNumber}@s.whatsapp.net`;
}





