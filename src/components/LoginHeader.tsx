import { APP_CONTAINER_CLASS } from "@/core/ui/layout";

type LoginHeaderProps = {
  appName: string;
};

export function LoginHeader({ appName }: LoginHeaderProps) {
  return (
    <header className="app-header">
      <div
        className={`${APP_CONTAINER_CLASS} app-header-inner login-header-inner`}
      >
        <span className="app-header-title">{appName}</span>
      </div>
    </header>
  );
}
