import React, { useState, useEffect, useRef } from "react";
// app/_layout.tsx  (o index.tsx si no usás router)
import "../src/i18n";

import { Stack } from "expo-router";


import {
  View,
  Text,
  TextInput,
  Button,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Image,
  TouchableOpacity,
} from "react-native";
import { Picker } from "@react-native-picker/picker";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useUser } from "../context/UserContext";
import { router } from "expo-router";
import { detectarYFormatearMatricula, paises } from "../utils/matricula_utils";
import { iconMap } from "../utils/iconMap";
import aircraftList from "../data/aircraftList";

import { useTranslation } from "react-i18next";
import i18n from "../src/i18n"; // si realmente exporta default i18n
import { setAppLanguage, loadAppLanguageOnStart, AppLanguage } from "../src/i18n/language";

const ADMIN_KEY_STORAGE = "airguardian.adminKey";

async function getAdminKey() {
  const saved = await AsyncStorage.getItem(ADMIN_KEY_STORAGE);
  return (saved && saved.trim()) ? saved : "Pista"; // ✅ clave inicial
}

async function setAdminKey(newKey: string) {
  await AsyncStorage.setItem(ADMIN_KEY_STORAGE, newKey);
}



const modelosDesdeLista = aircraftList.reduce(
  (acc, modelo) => {
    if (modelo.category === 1) {
      acc.glider.push(modelo.name);
    } else {
      acc.motor.push(modelo.name);
    }
    return acc;
  },
  { motor: [], glider: [] } as { motor: string[]; glider: string[] }
);

export default function IndexScreen() {
  const { t } = useTranslation();
  const { setUser, setAircraft } = useUser();

  const [name, setName] = useState("");
  const [callsign, setCallsign] = useState("");
  const [country, setCountry] = useState("");
  const [password, setPassword] = useState("");
  const [aircraftType, setAircraftType] = useState<"motor" | "glider" | "">("");
  const [aircraftModel, setAircraftModel] = useState("");
  const [otroModelo, setOtroModelo] = useState("");
  const [customIcon, setCustomIcon] = useState("");
  const [iconoPreview, setIconoPreview] = useState("");
  const [modelosMotor, setModelosMotor] = useState<string[]>(modelosDesdeLista.motor);
  const [modelosGlider, setModelosGlider] = useState<string[]>(modelosDesdeLista.glider);
  const [iconosPersonalizados, setIconosPersonalizados] = useState<Record<string, string>>({});
  const [showPwd, setShowPwd] = useState(false);
  const [lang, setLang] = useState<AppLanguage>("system");


  const otroModeloRef = useRef<TextInput>(null);
  const scrollRef = useRef<ScrollView>(null);

  // ✅ 1) Cargar idioma guardado al iniciar
useEffect(() => {
  const loadLang = async () => {
    try {
      await loadAppLanguageOnStart();
      // reflejar en el picker lo que haya guardado indicando "system|en|es"
      const saved = (await AsyncStorage.getItem("airguardian.language")) as AppLanguage | null;
      setLang(saved || "system");
    } catch (e) {
      console.error("Error loading lang:", e);
    }
  };
  loadLang();
}, []);


  // ✅ 2) Guardar y aplicar idioma cuando cambia
const changeLang = async (newLang: AppLanguage) => {
  try {
    setLang(newLang);
    await setAppLanguage(newLang);
  } catch (e) {
    console.error("Error changing lang:", e);
  }
};


  useEffect(() => {
    const cargarModelosGuardados = async () => {
      try {
        const motorGuardados = await AsyncStorage.getItem("modelosMotor");
        const gliderGuardados = await AsyncStorage.getItem("modelosGlider");
        if (motorGuardados) {
          const nuevos = JSON.parse(motorGuardados);
          setModelosMotor((prev) => Array.from(new Set([...prev, ...nuevos])));
        }
        if (gliderGuardados) {
          const nuevos = JSON.parse(gliderGuardados);
          setModelosGlider((prev) => Array.from(new Set([...prev, ...nuevos])));
        }
      } catch (error) {
        console.error("Error al cargar modelos personalizados:", error);
      }
    };
    cargarModelosGuardados();
  }, []);

  useEffect(() => {
    const cargarDatosPrevios = async () => {
      try {
        const datos = await AsyncStorage.getItem("datosUsuario");
        if (datos) {
          const { name, callsign, password, aircraftType, aircraftModel, otroModelo, customIcon } =
            JSON.parse(datos);

          setName(name || "");
          setCallsign(callsign || "");
          setPassword(password || "");
          setAircraftType(aircraftType || "");
          setAircraftModel(aircraftModel || "");
          setOtroModelo(otroModelo || "");
          setCustomIcon(customIcon || "");
        }
      } catch (e) {
        console.error("Error al cargar datos previos:", e);
      }
    };
    cargarDatosPrevios();
  }, []);

  useEffect(() => {
    const cargarIconosPersonalizados = async () => {
      try {
        const datos = await AsyncStorage.getItem("iconosPersonalizados");
        if (datos) setIconosPersonalizados(JSON.parse(datos));
      } catch (e) {
        console.error("Error al cargar íconos personalizados:", e);
      }
    };
    cargarIconosPersonalizados();
  }, []);

  useEffect(() => {
    if (aircraftModel === "otro") {
      setTimeout(() => otroModeloRef.current?.focus(), 100);
    }
  }, [aircraftModel]);

  useEffect(() => {
    if (aircraftModel !== "otro") setCustomIcon("");
  }, [aircraftModel]);

  useEffect(() => {
    const modeloFinal = aircraftModel === "otro" ? otroModelo.trim() : aircraftModel;

    let icono = aircraftType === "glider" ? "1" : "2";

    if (modeloFinal === "Parapente") icono = "8";
    else if (modeloFinal === "Paramotor") icono = "9";
    else if (modeloFinal === "Ala delta") icono = "10";
    else if (modeloFinal === "Ala delta motor") icono = "11";
    else {
      const encontrado = aircraftList.find((a) => a.name === modeloFinal);
      if (encontrado) icono = `${encontrado.category}`;
    }

    const iconoGuardado = iconosPersonalizados[modeloFinal];
    if (iconoGuardado) icono = iconoGuardado;

    if (customIcon.trim() && iconMap[customIcon.trim()]) icono = customIcon.trim();

    if (!iconMap[icono]) icono = "2";

    setIconoPreview(icono);
  }, [aircraftType, aircraftModel, otroModelo, customIcon, iconosPersonalizados]);

  const eliminarModelo = async (modelo: string) => {
    try {
      const key = aircraftType === "motor" ? "modelosMotor" : "modelosGlider";
      const listaActual = aircraftType === "motor" ? modelosMotor : modelosGlider;
      const nuevaLista = listaActual.filter((m) => m !== modelo);
      await AsyncStorage.setItem(key, JSON.stringify(nuevaLista));
      if (aircraftType === "motor") setModelosMotor(nuevaLista);
      else setModelosGlider(nuevaLista);

      Alert.alert(t("index.modelDeletedTitle"), t("index.modelDeletedBody", { model: modelo }));
    } catch (error) {
      console.error("Error al eliminar modelo:", error);
    }
  };

  const handleLogin = async () => {
    if (
      !name.trim() ||
      !callsign.trim() ||
      !aircraftType ||
      aircraftModel === "" ||
      (aircraftModel === "otro" && !otroModelo.trim())
    ) {
      Alert.alert(t("index.missingFieldsTitle"), t("index.missingFieldsBody"));
      return;
    }

    const modeloFinal = aircraftModel === "otro" ? otroModelo.trim() : aircraftModel;

    if (aircraftModel === "otro" && modeloFinal) {
      const key = aircraftType === "motor" ? "modelosMotor" : "modelosGlider";
      const listaActual = aircraftType === "motor" ? modelosMotor : modelosGlider;
      const actualizados = Array.from(new Set([...listaActual, modeloFinal]));
      await AsyncStorage.setItem(key, JSON.stringify(actualizados));
      if (aircraftType === "motor") setModelosMotor(actualizados);
      else setModelosGlider(actualizados);

      if (customIcon) {
        const nuevosIconos = { ...iconosPersonalizados, [modeloFinal]: customIcon };
        await AsyncStorage.setItem("iconosPersonalizados", JSON.stringify(nuevosIconos));
        setIconosPersonalizados(nuevosIconos);
      }
    }

    const adminKey = await getAdminKey();
    const isAdmin = password.trim().toLowerCase() === adminKey.toLowerCase();

    const role = isAdmin ? "aeroclub" : "pilot";

    const finalIcon = iconMap[iconoPreview] ? iconoPreview : "2";

    setUser(name.trim(), role, callsign.trim());
    setAircraft(aircraftType, modeloFinal, finalIcon, callsign.trim());

    await AsyncStorage.setItem(
      "datosUsuario",
      JSON.stringify({
        name: name.trim(),
        callsign: callsign.trim(),
        password,
        aircraftType,
        aircraftModel,
        otroModelo,
        customIcon,
      })
    );

    router.push("/Radar");
  };

  const goToPistaConClave = async () => {

    const adminKey = await getAdminKey();
    if (password.trim().toLowerCase() !== adminKey.toLowerCase()) {

      Alert.alert(t("index.restrictedTitle"), t("index.restrictedBody"));
      return;
    }

    const nombre = name.trim() || "Admin";
    const matricula = callsign.trim() || "ADM";
    setUser(nombre, "aeroclub", matricula);

    const modeloFinal =
      aircraftModel === "otro"
        ? otroModelo.trim() || t("index.genericAircraft")
        : aircraftModel || t("index.genericAircraft");

    const tipoFinal = aircraftType || "motor";
    const iconFinal = iconMap[iconoPreview] ? iconoPreview : "2";
    setAircraft(tipoFinal, modeloFinal, iconFinal, matricula);

    router.push("/Pista");
  };

  const handleCallsignChange = (text: string) => {
    const clean = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const formateada = detectarYFormatearMatricula(clean);
    setCallsign(formateada);

    const prefijos = Object.keys(paises).sort((a, b) => b.length - a.length);
    for (const prefijo of prefijos) {
      if (clean.startsWith(prefijo)) {
        setCountry(paises[prefijo].nombre);
        return;
      }
    }
    setCountry("");
  };

return (
  <>
    <Stack.Screen
      options={{
        title: t("nav.pilot"), // "Pilot" / "Piloto"
      }}
    />

    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={Platform.OS === "ios" ? 100 : 0}
    >
      {/* Contenedor para poder posicionar el botón ⚙️ sin dramas */}
      <View style={{ flex: 1 }}>
        <TouchableOpacity
          onPress={() => router.push("/settings")}
          style={{
            position: "absolute",
            top: Platform.OS === "android" ? 50 : 60,
            right: 14,
            zIndex: 999,
            backgroundColor: "white",
            borderRadius: 18,
            paddingHorizontal: 12,
            paddingVertical: 8,
            borderWidth: 1,
            borderColor: "#ddd",
            elevation: 4,
          }}
        >
          <Text style={{ fontWeight: "800" }}>⚙️</Text>
        </TouchableOpacity>

        <ScrollView
          ref={scrollRef}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ flexGrow: 1, padding: 20, paddingBottom: 140 }}
        >
          {/* ✅ Selector de idioma */}
          <Text style={styles.label}>{t("settings.language")}:</Text>
          <Picker selectedValue={lang} onValueChange={(v) => changeLang(v as AppLanguage)} style={styles.picker}>
            <Picker.Item label={t("settings.system")} value="system" />
            <Picker.Item label={t("settings.english")} value="en" />
            <Picker.Item label={t("settings.spanish")} value="es" />
          </Picker>


          <Text style={styles.label}>{t("auth.enterName")}:</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder={t("index.namePlaceholder")}
          />

          <Text style={styles.label}>{t("index.callsignLabel")}:</Text>
          <TextInput
            style={styles.input}
            value={callsign}
            onChangeText={handleCallsignChange}
            placeholder={t("index.callsignPlaceholder")}
            autoCapitalize="characters"
          />

          {country !== "" && (
            <Text style={styles.label}>
              {t("index.countryDetected")}: {country}
            </Text>
          )}

          <Text style={styles.label}>{t("index.aircraftTypeLabel")}:</Text>
          <Picker
            selectedValue={aircraftType}
            onValueChange={(value) => {
              setAircraftType(value);
              setAircraftModel("");
              setOtroModelo("");
              setCustomIcon("");
            }}
            style={styles.picker}
          >
            <Picker.Item label={t("index.select")} value="" />
            <Picker.Item label={t("index.motor")} value="motor" />
            <Picker.Item label={t("index.glider")} value="glider" />
          </Picker>

          {aircraftType !== "" && (
            <>
              <Text style={styles.label}>{t("index.aircraftModelLabel")}:</Text>
              <Picker
                selectedValue={aircraftModel}
                onValueChange={setAircraftModel}
                style={styles.picker}
              >
                <Picker.Item label={t("index.select")} value="" />
                <Picker.Item label={t("index.other")} value="otro" />

                {aircraftType === "glider" && (
                  <>
                    <Picker.Item label={t("index.paraglider")} value="Parapente" />
                    <Picker.Item label={t("index.hangGlider")} value="Ala delta" />
                  </>
                )}

                {aircraftType === "motor" && (
                  <>
                    <Picker.Item label={t("index.paramotor")} value="Paramotor" />
                    <Picker.Item label={t("index.hangGliderMotor")} value="Ala delta motor" />
                  </>
                )}

                {(aircraftType === "motor" ? modelosMotor : modelosGlider).map((modelo) => (
                  <Picker.Item key={modelo} label={modelo} value={modelo} />
                ))}
              </Picker>

              {aircraftModel === "otro" && (
                <>
                  <TextInput
                    ref={otroModeloRef}
                    style={styles.input}
                    value={otroModelo}
                    onChangeText={setOtroModelo}
                    placeholder={t("index.manualModelPlaceholder")}
                    onFocus={() => scrollRef.current?.scrollToEnd({ animated: true })}
                  />

                  <Text style={styles.label}>{t("index.chooseCategory")}:</Text>
                  <View style={styles.iconGallery}>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((num) => {
                      const iconName = `${num}`;
                      return (
                        <TouchableOpacity key={iconName} onPress={() => setCustomIcon(iconName)}>
                          <Image
                            source={iconMap[iconName]}
                            style={[styles.iconOption, customIcon === iconName && styles.iconSelected]}
                          />
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </>
              )}

              {iconoPreview !== "" && (
                <Image
                  source={iconMap[iconoPreview] || iconMap["default.png"]}
                  style={{ width: 60, height: 60, alignSelf: "center", marginVertical: 10 }}
                />
              )}
            </>
          )}

<Text style={styles.label}>{t("index.adminPasswordLabel")}:</Text>

<View style={{ position: "relative" }}>
  <TextInput
    style={[styles.input, { paddingRight: 50 }]}
    value={password}
    onChangeText={setPassword}
    secureTextEntry={!showPwd}
    placeholder={t("index.optional")}
    onFocus={() => {
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 150);
    }}
  />

  <TouchableOpacity
    onPress={() => setShowPwd((v) => !v)}
    style={{ position: "absolute", right: 12, top: 12 }}
  >
    <Text style={{ fontSize: 18 }}>{showPwd ? "🙈" : "👁️"}</Text>
  </TouchableOpacity>
</View>


          <View style={{ gap: 8, marginTop: 6 }}>
            <Button title={t("index.enter")} onPress={handleLogin} />
            <Button title={t("index.goPistaAdmin")} onPress={goToPistaConClave} color="#6C63FF" />
          </View>

          {aircraftModel && aircraftModel !== "otro" && (
            <View style={{ marginTop: 10 }}>
              <Button
                title={t("index.deleteModelBtn", { model: aircraftModel })}
                color="red"
                onPress={() => eliminarModelo(aircraftModel)}
              />
            </View>
          )}
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  </>
);

}

const styles = StyleSheet.create({
  container: { flexGrow: 1, padding: 20, paddingBottom: 120 },
  label: { marginTop: 10 },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 5,
    padding: 10,
    marginBottom: 10,
  },
  picker: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 5,
    marginBottom: 10,
  },
  iconGallery: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    marginVertical: 10,
  },
  iconOption: {
    width: 60,
    height: 60,
    margin: 5,
    borderWidth: 2,
    borderColor: "transparent",
    borderRadius: 8,
  },
  iconSelected: {
    borderColor: "#007AFF",
  },
});
