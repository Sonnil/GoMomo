// Deep-link handler for gomomo://verify-email?code=&email=&session_id=&tenant_id=
// This screen is reached when the user taps a verification link that
// is intercepted by the app via Universal Links or the gomomo:// scheme.

import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

const API_BASE = 'https://gomomo.ai'; // TODO: make configurable

type Status = 'verifying' | 'success' | 'error';

export default function VerifyEmailScreen() {
  const { code, email, session_id, tenant_id } = useLocalSearchParams<{
    code: string;
    email: string;
    session_id: string;
    tenant_id: string;
  }>();
  const router = useRouter();
  const [status, setStatus] = useState<Status>('verifying');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!code || !email) {
      setStatus('error');
      setErrorMsg('Missing verification parameters.');
      return;
    }

    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/auth/verify-code`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, email, session_id, tenant_id }),
        });

        if (res.ok) {
          setStatus('success');
          // Navigate back to the main agent screen after a short delay
          setTimeout(() => router.replace('/'), 2000);
        } else {
          const data = await res.json().catch(() => ({}));
          setStatus('error');
          setErrorMsg(data.error || 'Verification failed. Please try again.');
        }
      } catch {
        setStatus('error');
        setErrorMsg('Network error. Please check your connection.');
      }
    })();
  }, [code, email, session_id, tenant_id, router]);

  return (
    <View style={styles.container}>
      {status === 'verifying' && (
        <>
          <ActivityIndicator size="large" color="#6366f1" />
          <Text style={styles.text}>Verifying your email…</Text>
        </>
      )}

      {status === 'success' && (
        <>
          <Text style={styles.icon}>✅</Text>
          <Text style={styles.text}>Email verified!</Text>
          <Text style={styles.sub}>Returning to agent…</Text>
        </>
      )}

      {status === 'error' && (
        <>
          <Text style={styles.icon}>❌</Text>
          <Text style={styles.text}>Verification failed</Text>
          <Text style={styles.sub}>{errorMsg}</Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#09090b',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  icon: {
    fontSize: 48,
    marginBottom: 16,
  },
  text: {
    color: '#fafafa',
    fontSize: 18,
    fontWeight: '600',
    marginTop: 16,
    textAlign: 'center',
  },
  sub: {
    color: '#71717a',
    fontSize: 14,
    marginTop: 8,
    textAlign: 'center',
  },
});
