// ============================================================
// Booking Confirmation Card — React Native
//
// Renders a structured confirmation bubble when the agent
// successfully books an appointment via confirm_booking.
//
// Shows: date/time, timezone, service, reference code, and
// an optional "Add to Calendar" action (Google Calendar URL).
// ============================================================

import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import type { BookingData } from '../lib/chat';

interface BookingConfirmationCardProps {
  booking: BookingData;
}

export function BookingConfirmationCard({ booking }: BookingConfirmationCardProps) {
  const handleAddToCalendar = () => {
    if (booking.add_to_calendar_url) {
      Linking.openURL(booking.add_to_calendar_url);
    }
  };

  return (
    <View style={styles.card}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerIcon}>✅</Text>
        <Text style={styles.headerTitle}>Booking Confirmed</Text>
      </View>

      {/* Details */}
      <View style={styles.details}>
        {/* Date/Time */}
        <View style={styles.row}>
          <Text style={styles.label}>📅</Text>
          <Text style={styles.value}>{booking.display_time}</Text>
        </View>

        {/* Timezone */}
        <View style={styles.row}>
          <Text style={styles.label}>🌐</Text>
          <Text style={styles.value}>{booking.timezone.replace(/_/g, ' ')}</Text>
        </View>

        {/* Service */}
        {booking.service && (
          <View style={styles.row}>
            <Text style={styles.label}>💇</Text>
            <Text style={styles.value}>{booking.service}</Text>
          </View>
        )}

        {/* Client name */}
        {booking.client_name && (
          <View style={styles.row}>
            <Text style={styles.label}>👤</Text>
            <Text style={styles.value}>{booking.client_name}</Text>
          </View>
        )}

        {/* Reference code */}
        <View style={styles.row}>
          <Text style={styles.label}>🔖</Text>
          <View style={styles.refBadge}>
            <Text style={styles.refText}>{booking.reference_code.toUpperCase()}</Text>
          </View>
        </View>
      </View>

      {/* Add to Calendar action */}
      {booking.add_to_calendar_url ? (
        <Pressable style={styles.calendarBtn} onPress={handleAddToCalendar}>
          <Text style={styles.calendarBtnText}>📆 Add to Calendar</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#0f1a14',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#22c55e33',
    padding: 16,
    maxWidth: '88%',
    marginVertical: 4,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
    gap: 8,
  },
  headerIcon: {
    fontSize: 18,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#22c55e',
  },

  // Details
  details: {
    gap: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  label: {
    fontSize: 14,
    width: 22,
    textAlign: 'center',
  },
  value: {
    fontSize: 14,
    color: '#e4e4e7',
    flex: 1,
  },

  // Reference badge
  refBadge: {
    backgroundColor: '#27272a',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  refText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#a1a1aa',
    letterSpacing: 1,
    fontFamily: undefined, // uses system monospace-like on most devices
  },

  // Calendar button
  calendarBtn: {
    marginTop: 12,
    backgroundColor: '#6366f1',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  calendarBtnText: {
    color: '#ffffff',
    fontWeight: '600',
    fontSize: 14,
  },
});
