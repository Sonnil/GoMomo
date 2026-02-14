// Settings Screen — privacy, terms, data deletion, and future preferences.
// All legal links open in the device's external browser (not a WebView).

import {
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

const BASE_URL = 'https://gomomo.ai';

interface SettingsRowProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  url: string;
}

function SettingsRow({ icon, label, url }: SettingsRowProps) {
  return (
    <TouchableOpacity
      style={styles.row}
      onPress={() => Linking.openURL(url)}
      activeOpacity={0.7}
    >
      <Ionicons name={icon} size={20} color="#a1a1aa" style={styles.rowIcon} />
      <Text style={styles.rowLabel}>{label}</Text>
      <Ionicons name="open-outline" size={16} color="#71717a" />
    </TouchableOpacity>
  );
}

export default function SettingsScreen() {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Legal section */}
      <Text style={styles.sectionTitle}>Legal</Text>
      <View style={styles.section}>
        <SettingsRow
          icon="shield-checkmark-outline"
          label="Privacy Policy"
          url={`${BASE_URL}/privacy`}
        />
        <View style={styles.separator} />
        <SettingsRow
          icon="document-text-outline"
          label="Terms of Service"
          url={`${BASE_URL}/terms`}
        />
        <View style={styles.separator} />
        <SettingsRow
          icon="trash-outline"
          label="Request Data Deletion"
          url={`${BASE_URL}/data-deletion`}
        />
      </View>

      {/* About section */}
      <Text style={styles.sectionTitle}>About</Text>
      <View style={styles.section}>
        <SettingsRow
          icon="globe-outline"
          label="Visit gomomo.ai"
          url={BASE_URL}
        />
      </View>

      {/* Version info */}
      <Text style={styles.version}>gomomo v1.0.0</Text>

      {/* TODO: Future sections
        - Notification preferences (push on/off, channels)
        - Account management (email, sign out)
        - Biometric lock toggle
        - Theme override (system / dark / light)
      */}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#09090b',
  },
  content: {
    padding: 16,
    paddingTop: 8,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#71717a',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 24,
    marginBottom: 8,
    marginLeft: 4,
  },
  section: {
    backgroundColor: '#111113',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#27272a',
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  rowIcon: {
    marginRight: 12,
  },
  rowLabel: {
    flex: 1,
    fontSize: 16,
    color: '#fafafa',
  },
  separator: {
    height: 1,
    backgroundColor: '#27272a',
    marginLeft: 48,
  },
  version: {
    textAlign: 'center',
    color: '#71717a',
    fontSize: 12,
    marginTop: 32,
    marginBottom: 16,
  },
});
