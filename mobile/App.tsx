import { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { createClient } from './src/api';
import {
  STATUS_LABEL,
  type CompanionStatus,
  type MissionStatus,
} from './src/types';

const COLORS = {
  bg: '#0a0e15',
  elevated: '#101623',
  border: '#1d2637',
  text: '#d7dfec',
  dim: '#8a94aa',
  accent: '#3dd9ff',
  ok: '#7ee2a8',
  warn: '#e5c07b',
  danger: '#ff7a90',
};

const STATUS_COLOR: Record<MissionStatus, string> = {
  pending: COLORS.dim,
  running: COLORS.accent,
  blocked: COLORS.warn,
  done: COLORS.ok,
  failed: COLORS.danger,
};

export default function App() {
  const [relayUrl, setRelayUrl] = useState('http://192.168.0.10:4747');
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const poll = useCallback(async () => {
    if (!connected) return;
    try {
      const next = await createClient(relayUrl).status();
      setStatus(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'falha ao conectar');
    }
  }, [connected, relayUrl]);

  useEffect(() => {
    if (!connected) return;
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => clearInterval(timer);
  }, [connected, poll]);

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Text style={styles.brand}>NEXUS COMPANION</Text>
        <Text style={styles.sub}>
          {status
            ? `${status.workspaceName} · ${status.activeMissions} ativa(s)`
            : 'monitor de missões'}
        </Text>
      </View>

      {!connected ? (
        <View style={styles.connect}>
          <Text style={styles.label}>RELAY NA REDE LOCAL</Text>
          <TextInput
            style={styles.input}
            value={relayUrl}
            onChangeText={setRelayUrl}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="http://ip:porta"
            placeholderTextColor={COLORS.dim}
          />
          <Text
            style={styles.connectBtn}
            onPress={() => setConnected(true)}
          >
            CONECTAR ›
          </Text>
        </View>
      ) : (
        <>
          {error && <Text style={styles.error}>{error}</Text>}
          <FlatList
            data={status?.missions ?? []}
            keyExtractor={(m) => m.id}
            contentContainerStyle={styles.list}
            ListEmptyComponent={
              <Text style={styles.empty}>Nenhuma missão neste workspace.</Text>
            }
            renderItem={({ item }) => (
              <View style={styles.card}>
                <View style={styles.cardHead}>
                  <View
                    style={[
                      styles.dot,
                      { backgroundColor: STATUS_COLOR[item.status] },
                    ]}
                  />
                  <Text style={styles.title} numberOfLines={2}>
                    {item.title}
                  </Text>
                </View>
                <Text style={styles.meta}>
                  <Text style={{ color: STATUS_COLOR[item.status] }}>
                    {STATUS_LABEL[item.status]}
                  </Text>
                  {'  ·  '}
                  {item.agentCount} agente(s)
                </Text>
              </View>
            )}
          />
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  header: { padding: 20, paddingBottom: 12 },
  brand: {
    color: COLORS.accent,
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 2,
  },
  sub: { color: COLORS.dim, fontSize: 12, marginTop: 4 },
  connect: { padding: 20 },
  label: {
    color: COLORS.dim,
    fontSize: 11,
    letterSpacing: 1,
    marginBottom: 8,
  },
  input: {
    backgroundColor: COLORS.elevated,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 8,
    color: COLORS.text,
    padding: 12,
    fontSize: 14,
  },
  connectBtn: {
    marginTop: 16,
    color: COLORS.accent,
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 1,
  },
  error: { color: COLORS.danger, paddingHorizontal: 20, paddingBottom: 8 },
  list: { padding: 20, paddingTop: 8, gap: 12 },
  empty: { color: COLORS.dim, textAlign: 'center', marginTop: 24 },
  card: {
    backgroundColor: COLORS.elevated,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
  },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 4 },
  title: { color: COLORS.text, fontSize: 14, fontWeight: '600', flex: 1 },
  meta: { color: COLORS.dim, fontSize: 12, marginTop: 8 },
});
