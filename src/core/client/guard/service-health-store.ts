import { Store } from "@tanstack/store";

export type ServiceHealthStatus =
  | "healthy"
  | "degraded"
  | "offline"
  | "recovered";

export type ServiceIssueKind = "network" | "service" | "database" | "timeout";

type ServiceHealthState = {
  status: ServiceHealthStatus;
  message: string | null;
  visible: boolean;
};

type ServiceHealthMessageCatalog = {
  issueMessages: Record<ServiceIssueKind, string>;
  recoveredMessage: string;
};

export function createServiceHealthStore(
  messages: ServiceHealthMessageCatalog,
) {
  const serviceHealthStore = new Store<ServiceHealthState>({
    status: "healthy",
    message: null,
    visible: false,
  });

  function reportServiceIssue(options: {
    kind: ServiceIssueKind;
    message?: string;
  }) {
    serviceHealthStore.setState(() => ({
      status: options.kind === "network" ? "offline" : "degraded",
      message: options.message ?? messages.issueMessages[options.kind],
      visible: true,
    }));
  }

  function reportServiceRecovered() {
    serviceHealthStore.setState((previous) => {
      if (previous.status === "healthy" && !previous.visible) {
        return previous;
      }

      return {
        status: "recovered",
        message: messages.recoveredMessage,
        visible: true,
      };
    });
  }

  function dismissServiceHealthNotice() {
    serviceHealthStore.setState((previous) => ({
      ...previous,
      visible: false,
    }));
  }

  function clearServiceHealthState() {
    serviceHealthStore.setState(() => ({
      status: "healthy",
      message: null,
      visible: false,
    }));
  }

  return {
    serviceHealthStore,
    reportServiceIssue,
    reportServiceRecovered,
    dismissServiceHealthNotice,
    clearServiceHealthState,
  };
}
