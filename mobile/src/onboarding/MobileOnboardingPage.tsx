import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native'
import { BellRing, MessageSquare } from 'lucide-react-native'
import type { MobileOnboardingStep } from './mobile-onboarding-plan'
import { mobileOnboardingStyles as styles } from './mobile-onboarding-styles'
import type { MobileSessionView } from '../storage/session-view-preferences'
import { colors } from '../theme/mobile-theme'

export type NotificationOnboardingChoice = 'enable' | 'skip'
export type MobileOnboardingBusyChoice = MobileSessionView | NotificationOnboardingChoice | null

type Props = {
  step: MobileOnboardingStep
  width: number
  active: boolean
  busyChoice: MobileOnboardingBusyChoice
  error: string | null
  /** F-1037: desktop Nexus — avisos locais do app, sem o serviço de push do Orca. */
  nexusHost?: boolean
  onSessionChoice: (view: MobileSessionView) => void
  onNotificationChoice: (choice: NotificationOnboardingChoice) => void
}

export function MobileOnboardingPage({
  step,
  width,
  active,
  busyChoice,
  error,
  nexusHost = false,
  onSessionChoice,
  onNotificationChoice
}: Props) {
  const busy = busyChoice !== null
  const isSessionView = step === 'session-view'

  return (
    <ScrollView
      style={[styles.page, { width }]}
      contentContainerStyle={styles.pageContent}
      showsVerticalScrollIndicator={false}
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}
    >
      <View style={styles.content}>
        <View style={styles.iconSurface}>
          {isSessionView ? (
            <MessageSquare size={30} color={colors.textPrimary} />
          ) : (
            <BellRing size={30} color={colors.textPrimary} />
          )}
        </View>
        <Text style={styles.title}>
          {isSessionView ? 'Como as sessões devem abrir?' : 'Ativar notificações'}
        </Text>
        <Text style={styles.body}>
          {isSessionView
            ? 'Escolha se as sessões de agente compatíveis abrem no terminal ou na UI de chat neste aparelho. Toque e segure a aba de uma sessão para trocar a visualização, ou mude o padrão depois nas Configurações.'
            : nexusHost
              ? 'Receba um aviso quando um agente pedir aprovação, esperar por você ou terminar.'
              : 'Receba um aviso quando um agente terminar uma tarefa ou precisar de você.'}
        </Text>
        {!isSessionView ? (
          <Text style={styles.body}>
            {nexusHost
              ? 'Os avisos são locais deste aparelho, enquanto o app está conectado ao desktop Nexus.'
              : 'Por padrão, os avisos chegam depois de 3 minutos sem uso do desktop.'}
          </Text>
        ) : null}
      </View>

      <View style={styles.footer}>
        {!isSessionView ? (
          <Text style={styles.disclosure}>
            {nexusHost
              ? 'Sem servidor de push no meio. Mude quando quiser nas Configurações.'
              : 'Entregues pelo serviço de push do Orca. Mude quando quiser nas Configurações.'}
          </Text>
        ) : null}
        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
        {isSessionView ? (
          <SessionViewChoices busyChoice={busyChoice} disabled={busy} onChoice={onSessionChoice} />
        ) : (
          <NotificationChoices
            busyChoice={busyChoice}
            disabled={busy}
            onChoice={onNotificationChoice}
          />
        )}
      </View>
    </ScrollView>
  )
}

function SessionViewChoices({
  busyChoice,
  disabled,
  onChoice
}: {
  busyChoice: MobileOnboardingBusyChoice
  disabled: boolean
  onChoice: (view: MobileSessionView) => void
}) {
  return (
    <>
      <ChoiceButton
        label="Usar UI de chat"
        accessibilityLabel="Abrir sessões na UI de chat"
        primary
        busy={busyChoice === 'chat'}
        disabled={disabled}
        onPress={() => onChoice('chat')}
      />
      <ChoiceButton
        label="Manter terminal"
        accessibilityLabel="Abrir sessões no terminal"
        busy={busyChoice === 'terminal'}
        disabled={disabled}
        onPress={() => onChoice('terminal')}
      />
    </>
  )
}

function NotificationChoices({
  busyChoice,
  disabled,
  onChoice
}: {
  busyChoice: MobileOnboardingBusyChoice
  disabled: boolean
  onChoice: (choice: NotificationOnboardingChoice) => void
}) {
  return (
    <>
      <ChoiceButton
        label="Ativar notificações"
        accessibilityLabel="Ativar avisos dos agentes"
        primary
        busy={busyChoice === 'enable'}
        disabled={disabled}
        onPress={() => onChoice('enable')}
      />
      <ChoiceButton
        label="Agora não"
        accessibilityLabel="Pular notificações por enquanto"
        busy={busyChoice === 'skip'}
        disabled={disabled}
        onPress={() => onChoice('skip')}
      />
    </>
  )
}

function ChoiceButton({
  label,
  accessibilityLabel,
  primary = false,
  busy,
  disabled,
  onPress
}: {
  label: string
  accessibilityLabel?: string
  primary?: boolean
  busy: boolean
  disabled: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      style={({ pressed }) => [
        primary ? styles.primaryButton : styles.secondaryButton,
        pressed && styles.buttonPressed,
        disabled && styles.buttonDisabled
      ]}
      onPress={onPress}
    >
      {busy ? (
        <ActivityIndicator color={primary ? colors.bgBase : colors.textSecondary} />
      ) : (
        <Text style={primary ? styles.primaryButtonText : styles.secondaryButtonText}>{label}</Text>
      )}
    </Pressable>
  )
}
