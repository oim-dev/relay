import { NAV_CONTROLS } from "./config/nav-states.config";
import { KitNavSample } from "./ui/kit-nav-sample/kit-nav-sample";
import styles from "./styles/kit-nav-states.module.css";

/**
 * Показывает состояния навигационных контролов каркаса на общей подложке: покой,
 * наведение, текущий, раскрытый, недоступный и фокус. Образцы статичны и инертны;
 * живое поведение мышью и клавиатурой показывает композиционный пример.
 *
 * Используется для:
 *  - сверки состояний навигации галереи и каркаса проекта
 */
export const KitNavStates = () => {
  return (
    <div className={styles.root}>
      {NAV_CONTROLS.map((row) => (
        <div key={row.title} className={styles.control}>
          <h4 className={styles.title}>{row.title}</h4>
          <ul className={styles.states}>
            {row.states.map((entry) => (
              <li key={entry.state} className={styles.state}>
                <span className={styles.name}>{entry.label}</span>
                <span className={styles.note}>{entry.note}</span>
                <div className={styles.sample} data-control={entry.control ?? row.control} inert>
                  <KitNavSample control={entry.control ?? row.control} state={entry.state} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
};
