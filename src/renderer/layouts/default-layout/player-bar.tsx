import styles from './player-bar.module.css';

import { Playerbar } from '/@/renderer/features/player/components/playerbar';

export const PlayerBar = () => {
    return (
        <div className={styles.container} id="player-bar">
            <Playerbar />
        </div>
    );
};
