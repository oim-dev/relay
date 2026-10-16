import clsx from "clsx";
import { useEffect, useState } from "react";
import { useIntersection } from "@mantine/hooks";
import { UserRound } from "lucide-react";
import { getGravatarUrl, markGravatarUnavailable } from "infra/gravatar";
import type { WorkAuthorAvatarProps } from "./types/work-author-avatar-props.type";
import styles from "./styles/work-author-avatar.module.css";

/**
 * Показывает человека, от имени которого создана конкретная точка.
 *
 * Используется для:
 *  - ленивого аватара с инициалами или нейтральным значком при неизвестном операторе
 */
export const WorkAuthorAvatar = (props: WorkAuthorAvatarProps) => {
  const { operator, size = 36, className, style, ...rootAttrs } = props;
  const { ref, entry } = useIntersection<HTMLSpanElement>({ rootMargin: "80px" });
  const email = operator?.email ?? null;
  const name = operator?.name?.trim() ?? "";
  const initials = name
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => [...part][0] ?? "")
    .join("")
    .toLocaleUpperCase("ru-RU");
  const [image, setImage] = useState<{ email: string; url: string | null }>({
    email: "",
    url: null,
  });
  const isVisible = entry?.isIntersecting === true;
  useEffect(() => {
    if (!isVisible || email === null) return;
    let isDisposed = false;
    void getGravatarUrl(email).then((url) => {
      if (!isDisposed) setImage({ email, url });
    });
    return () => {
      isDisposed = true;
    };
  }, [email, isVisible]);
  const url = image.email === email ? image.url : null;
  const hasImage = url !== null;
  const hasInitials = initials !== "";
  const isUnknown = !hasInitials;
  return (
    <span
      {...rootAttrs}
      ref={ref}
      className={clsx(styles.root, className)}
      style={{ ...style, width: size, height: size, fontSize: Math.max(10, size * 0.34) }}
      aria-hidden="true"
    >
      {hasInitials && <span>{initials}</span>}
      {isUnknown && <UserRound size={Math.round(size * 0.55)} />}
      {hasImage && (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className={styles.image}
          onError={() => {
            markGravatarUnavailable(url);
            if (email !== null) setImage({ email, url: null });
          }}
        />
      )}
    </span>
  );
};
