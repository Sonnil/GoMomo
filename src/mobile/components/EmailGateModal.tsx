// ============================================================
// Email Gate Modal — React Native
//
// Reuses the same backend endpoints as the web:
//   POST /api/auth/request-code
//   POST /api/auth/verify-code
//
// Two-step flow:
//   1. Collect email + newsletter opt-in → request code
//   2. Collect 6-digit OTP → verify code → dismiss
// ============================================================

import { useState, useCallback } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { BACKEND_BASE_URL } from '../lib/config';

interface EmailGateModalProps {
  visible: boolean;
  sessionId: string;
  tenantId: string;
  onVerified: (email: string) => void;
  onClose?: () => void;
}

export function EmailGateModal({
  visible,
  sessionId,
  tenantId,
  onVerified,
  onClose,
}: EmailGateModalProps) {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newsletterOptIn, setNewsletterOptIn] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Dev mode: show the OTP code in the UI so tester doesn't need email access
  const [devCode, setDevCode] = useState<string | null>(null);

  const handleRequestCode = useCallback(async () => {
    const trimmed = email.trim();
    if (!trimmed) {
      setError('Please enter your email.');
      return;
    }
    setError(null);
    setLoading(true);
    setDevCode(null);

    try {
      const res = await fetch(`${BACKEND_BASE_URL}/api/auth/request-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: trimmed,
          session_id: sessionId,
          tenant_id: tenantId,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Failed to send verification code.');
        return;
      }

      // In dev mode the backend returns the code for easy testing
      if (data.code) {
        setDevCode(data.code);
      }

      setStep('code');
    } catch {
      setError('Network error. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [email, sessionId, tenantId]);

  const handleVerifyCode = useCallback(async () => {
    const trimmedCode = code.trim();
    if (!trimmedCode) {
      setError('Please enter the verification code.');
      return;
    }
    setError(null);
    setLoading(true);

    try {
      const res = await fetch(`${BACKEND_BASE_URL}/api/auth/verify-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          code: trimmedCode,
          session_id: sessionId,
          tenant_id: tenantId,
          newsletter_opt_in: newsletterOptIn,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Verification failed. Please try again.');
        return;
      }

      onVerified(email.trim());
      // Reset for next time
      setStep('email');
      setEmail('');
      setCode('');
      setError(null);
      setDevCode(null);
    } catch {
      setError('Network error. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [email, code, sessionId, tenantId, newsletterOptIn, onVerified]);

  const handleBack = () => {
    setStep('email');
    setCode('');
    setError(null);
    setDevCode(null);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.overlay}
      >
        <View style={styles.modal}>
          {/* Close button */}
          {onClose && (
            <Pressable style={styles.closeBtn} onPress={onClose} hitSlop={12}>
              <Text style={styles.closeBtnText}>✕</Text>
            </Pressable>
          )}

          <Text style={styles.icon}>📧</Text>
          <Text style={styles.title}>
            {step === 'email' ? 'Continue with your email' : 'Enter verification code'}
          </Text>
          <Text style={styles.subtitle}>
            {step === 'email'
              ? "We'll send booking confirmations and updates here."
              : `We sent a 6-digit code to ${email}.`}
          </Text>

          {error && <Text style={styles.error}>{error}</Text>}

          {/* Dev mode: show OTP code for manual testing */}
          {devCode && step === 'code' && (
            <View style={styles.devBanner}>
              <Text style={styles.devBannerText}>
                🧪 Dev code: {devCode}
              </Text>
            </View>
          )}

          {step === 'email' ? (
            <>
              <TextInput
                style={styles.input}
                placeholder="you@example.com"
                placeholderTextColor="#71717a"
                value={email}
                onChangeText={setEmail}
                onSubmitEditing={handleRequestCode}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                editable={!loading}
                returnKeyType="send"
              />

              <View style={styles.switchRow}>
                <Switch
                  value={newsletterOptIn}
                  onValueChange={setNewsletterOptIn}
                  trackColor={{ false: '#27272a', true: '#6366f1' }}
                  thumbColor="#fafafa"
                />
                <Text style={styles.switchLabel}>Subscribe to gomomo updates</Text>
              </View>

              <Pressable
                style={[styles.button, loading && styles.buttonDisabled]}
                onPress={handleRequestCode}
                disabled={loading}
              >
                {loading ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.buttonText}>Send verification code</Text>
                )}
              </Pressable>
            </>
          ) : (
            <>
              <TextInput
                style={[styles.input, styles.codeInput]}
                placeholder="123456"
                placeholderTextColor="#71717a"
                value={code}
                onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
                onSubmitEditing={handleVerifyCode}
                keyboardType="number-pad"
                autoFocus
                maxLength={6}
                editable={!loading}
                returnKeyType="done"
              />

              <Pressable
                style={[
                  styles.button,
                  (loading || code.length < 6) && styles.buttonDisabled,
                ]}
                onPress={handleVerifyCode}
                disabled={loading || code.length < 6}
              >
                {loading ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.buttonText}>Verify</Text>
                )}
              </Pressable>

              <Pressable onPress={handleBack} disabled={loading}>
                <Text style={styles.linkText}>← Use a different email</Text>
              </Pressable>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  modal: {
    backgroundColor: '#111113',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: 40,
    borderWidth: 1,
    borderColor: '#27272a',
  },
  closeBtn: {
    position: 'absolute',
    top: 16,
    right: 16,
    zIndex: 1,
  },
  closeBtnText: {
    color: '#71717a',
    fontSize: 18,
  },
  icon: {
    fontSize: 36,
    textAlign: 'center',
    marginBottom: 8,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#fafafa',
    textAlign: 'center',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#71717a',
    textAlign: 'center',
    marginBottom: 16,
  },
  error: {
    color: '#ef4444',
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 12,
    backgroundColor: 'rgba(239,68,68,0.1)',
    padding: 8,
    borderRadius: 8,
    overflow: 'hidden',
  },
  devBanner: {
    backgroundColor: 'rgba(234,179,8,0.15)',
    borderRadius: 8,
    padding: 8,
    marginBottom: 12,
  },
  devBannerText: {
    color: '#eab308',
    fontSize: 13,
    textAlign: 'center',
    fontWeight: '600',
  },
  input: {
    backgroundColor: '#09090b',
    borderWidth: 1,
    borderColor: '#27272a',
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    color: '#fafafa',
    marginBottom: 12,
  },
  codeInput: {
    textAlign: 'center',
    letterSpacing: 8,
    fontSize: 22,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    gap: 10,
  },
  switchLabel: {
    color: '#a1a1aa',
    fontSize: 14,
    flex: 1,
  },
  button: {
    backgroundColor: '#6366f1',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 12,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#ffffff',
    fontWeight: '600',
    fontSize: 16,
  },
  linkText: {
    color: '#6366f1',
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: 4,
  },
});
