// ============================================================
// Booking Failure Banner — React Native
//
// Friendly UX when booking fails due to calendar integration
// issues, permission errors, or other infrastructure problems.
//
// Detects error patterns in assistant responses and renders
// a helpful callout instead of exposing raw backend errors.
// ============================================================

import { StyleSheet, Text, View } from 'react-native';

interface BookingFailureBannerProps {
  message: string;
}

/**
 * Check if the assistant's response indicates a calendar/booking
 * infrastructure failure (as opposed to a user-fixable error like
 * "that slot is taken").
 */
export function isCalendarFailure(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('calendar read failed') ||
    lower.includes('calendar integration') ||
    lower.includes('calendar is not connected') ||
    lower.includes('calendar not configured') ||
    lower.includes('calendar service') ||
    lower.includes('google calendar') && lower.includes('error') ||
    lower.includes('unable to check availability') && lower.includes('calendar') ||
    lower.includes('calendar permissions')
  );
}

/**
 * Check if the response indicates a booking-level error that
 * should be shown with a friendly wrapper.
 */
export function isBookingError(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('internal error occurred') ||
    lower.includes('something went wrong') && lower.includes('booking') ||
    lower.includes('unable to complete') && lower.includes('booking')
  );
}

export function BookingFailureBanner({ message }: BookingFailureBannerProps) {
  const isCalendar = isCalendarFailure(message);

  return (
    <View style={styles.banner}>
      <Text style={styles.icon}>{isCalendar ? '📅' : '⚠️'}</Text>
      <View style={styles.textContainer}>
        <Text style={styles.title}>
          {isCalendar
            ? "Calendar not available"
            : "Booking couldn't be completed"
          }
        </Text>
        <Text style={styles.body}>
          {isCalendar
            ? "This business hasn't connected a calendar yet. Try again later or contact support."
            : "Something went wrong with the booking. Please try again in a moment."
          }
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    backgroundColor: '#1a1207',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#eab30833',
    padding: 12,
    maxWidth: '88%',
    marginVertical: 4,
    gap: 10,
  },
  icon: {
    fontSize: 20,
    marginTop: 2,
  },
  textContainer: {
    flex: 1,
    gap: 4,
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
    color: '#eab308',
  },
  body: {
    fontSize: 13,
    color: '#a1a1aa',
    lineHeight: 18,
  },
});
