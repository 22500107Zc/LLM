import { useEffect } from "react";
import paths from "@/utils/paths";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import ProviderPrivacy from "@/components/ProviderPrivacy";

export default function DataHandling({ setHeader, setForwardBtn, setBackBtn }) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const TITLE = t("onboarding.data.title");
  const DESCRIPTION = t("onboarding.data.description");

  useEffect(() => {
    setHeader({ title: TITLE, description: DESCRIPTION });
    setForwardBtn({ showing: true, disabled: false, onClick: handleForward });
    setBackBtn({ showing: false, disabled: false, onClick: handleBack });
  }, []);

  function handleForward() {
    // The upstream onboarding survey transmitted the operator's email and use
    // case to a third-party endpoint. It is removed from the commercial build,
    // so this is the final onboarding step.
    navigate(paths.home());
  }

  function handleBack() {
    navigate(paths.onboarding.userSetup());
  }

  return (
    <div className="w-full flex items-center justify-center flex-col gap-y-6">
      <ProviderPrivacy />
      <p className="text-theme-text-secondary text-sm font-medium py-1">
        {t("onboarding.data.settingsHint")}
      </p>
    </div>
  );
}
