import { Text, View } from 'react-native';
import { utf8Length } from '@flashlink/protocol';

export default function App() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Text>{utf8Length('héllo')}</Text>
    </View>
  );
}
