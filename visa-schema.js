// Esquema del formulario de trámite de visa — fuente única de verdad,
// consumido por el backend (validación superficial) y el frontend (render dinámico)
// vía GET /api/visa/schema. Basado en "Gestión de Trámite de Visas Rangel".

const SI_NO = [
  { value: 'si', label: 'Sí' },
  { value: 'no', label: 'No' },
];

const SECTIONS = [
  {
    id: 'personal',
    title: 'Información Personal',
    fields: [
      { id: 'apellidos', label: 'Apellidos', type: 'text' },
      { id: 'nombres', label: 'Nombre(s)', type: 'text' },
      { id: 'otroNombreLegal', label: '¿Alguna vez has utilizado algún otro nombre legalmente?', type: 'text' },
      { id: 'sexo', label: 'Sexo', type: 'select', options: [
        { value: 'M', label: 'Masculino' }, { value: 'F', label: 'Femenino' } ] },
      { id: 'estadoCivil', label: 'Estado Civil', type: 'select', options: [
        { value: 'soltero', label: 'Soltero(a)' },
        { value: 'casado', label: 'Casado(a)' },
        { value: 'divorciado', label: 'Divorciado(a)' },
        { value: 'viudo', label: 'Viudo(a)' },
        { value: 'union_libre', label: 'Unión libre' } ] },
      { id: 'fechaNacimiento', label: 'Fecha de nacimiento', type: 'date' },
      { id: 'ciudadNacimiento', label: 'Ciudad de nacimiento', type: 'text' },
      { id: 'estadoNacimiento', label: 'Estado de nacimiento', type: 'text' },
      { id: 'nacionalidad', label: 'Nacionalidad', type: 'text' },
      { id: 'otraNacionalidad', label: '¿Tienes alguna otra nacionalidad diferente a la mencionada arriba?', type: 'text' },
      { id: 'residentePermanenteOtroPais', label: '¿Eres residente permanente de un país / región distinta a la mencionada arriba?', type: 'text' },
      { id: 'numeroIdentificacionPasaporte', label: 'Número de identificación de pasaporte', type: 'text' },
    ],
  },
  {
    id: 'domicilio',
    title: 'Domicilio y Número de Teléfono',
    fields: [
      { id: 'calleNumero', label: 'Calle y Número', type: 'text' },
      { id: 'domCiudad', label: 'Ciudad', type: 'text' },
      { id: 'domEstado', label: 'Estado', type: 'text' },
      { id: 'domCodigoPostal', label: 'Código Postal', type: 'text' },
      { id: 'domPais', label: 'País', type: 'text' },
      { id: 'celular', label: 'Número Celular', type: 'tel' },
      { id: 'otroCelular', label: '¿Has utilizado otro número celular en los últimos 5 años? En caso de contestar sí, ¿cuál?', type: 'text' },
      { id: 'correo', label: 'Correo electrónico', type: 'email' },
      { id: 'otroCorreo', label: '¿Has utilizado otro correo electrónico en los últimos 5 años? En caso de contestar sí, ¿cuál?', type: 'text' },
      { id: 'redesSociales', label: '¿Tienes presencia en redes sociales?', type: 'yesno' },
      { id: 'redesSocialesCuales', label: 'En caso de contestar sí, ¿cuáles?', type: 'text' },
      { id: 'redesSocialesUsuarios', label: 'Proporciona nombre de usuario de redes sociales utilizadas', type: 'text' },
      { id: 'otraRedSocial', label: '¿Has utilizado alguna otra red social en los últimos cinco años? En caso de contestar sí, ¿cuál?', type: 'text' },
    ],
  },
  {
    id: 'pasaporte',
    title: 'Información de Pasaporte / Información de Viaje',
    fields: [
      { id: 'numeroPasaporte', label: 'Número de pasaporte', type: 'text' },
      { id: 'paisEmisorPasaporte', label: 'País que emitió pasaporte', type: 'text' },
      { id: 'ciudadExpedicionPasaporte', label: 'Ciudad donde se expidió pasaporte', type: 'text' },
      { id: 'estadoExpedicionPasaporte', label: 'Estado donde se expidió pasaporte', type: 'text' },
      { id: 'paisExpedicionPasaporte', label: 'País donde se expidió pasaporte', type: 'text' },
      { id: 'fechaExpedicion', label: 'Fecha de expedición', type: 'date' },
      { id: 'pasaporteExtraviadoRobado', label: '¿Alguna vez has extraviado / te han robado algún pasaporte?', type: 'yesno', detailLabel: 'Detalla las circunstancias' },
    ],
  },
  {
    id: 'visita',
    title: 'Razón de Visita a Estados Unidos',
    fields: [
      { id: 'planesEspecificosViaje', label: '¿Tienes planes específicos de viaje?', type: 'textarea' },
      { id: 'fechaEstimadaLlegada', label: 'Fecha estimada de llegada', type: 'date' },
      { id: 'tiempoEstanciaEEUU', label: '¿Cuánto tiempo estará en los Estados Unidos?', type: 'text' },
      { id: 'direccionHospedaje', label: 'Dirección donde se hospedará', type: 'text' },
      { id: 'conQuienHospedara', label: '¿Con quién se hospedará?', type: 'text' },
      { id: 'personaFinanciaViaje', label: 'Persona que financiará su visita a los Estados Unidos', type: 'text' },
      { id: 'viajaConOtrasPersonas', label: '¿Qué otras personas viajarán contigo? En caso de responder que sí, ¿quiénes?', type: 'text' },
      { id: 'haVisitadoEEUU', label: '¿Has visitado alguna vez los Estados Unidos?', type: 'yesno', detailLabel: 'Detalla fechas/motivo' },
      { id: 'visaExpedidaAntes', label: '¿Alguna vez se te ha expedido una visa de los Estados Unidos?', type: 'yesno', detailLabel: 'Detalla tipo de visa y fecha' },
      { id: 'visaDenegadaAntes', label: '¿Alguna vez se te ha denegado una visa de los Estados Unidos?', type: 'yesno', detailLabel: 'Detalla fecha y motivo' },
      { id: 'apoyoPeticionInmigracion', label: '¿Alguna vez alguien te ha apoyado en elaborar una petición de inmigración con el departamento de ciudadanía y servicios de inmigración?', type: 'yesno', detailLabel: 'Detalla' },
    ],
  },
  {
    id: 'contactoEEUU',
    title: 'Información de Contacto en Estados Unidos',
    fields: [
      { id: 'contactoNombre', label: 'Nombre de su contacto en Estados Unidos', type: 'text' },
      { id: 'contactoOrganizacion', label: 'Nombre de la organización donde labora', type: 'text' },
      { id: 'contactoRelacion', label: 'Relación con esta persona', type: 'text' },
      { id: 'contactoDomicilio', label: 'Domicilio de su contacto en los Estados Unidos', type: 'text' },
      { id: 'contactoCelular', label: 'Número celular', type: 'tel' },
      { id: 'contactoCorreo', label: 'Correo electrónico', type: 'email' },
    ],
  },
  {
    id: 'familiar',
    title: 'Información Familiar',
    fields: [
      { id: 'padreNombreCompleto', label: 'Nombre completo de su padre', type: 'text' },
      { id: 'padreFechaNacimiento', label: 'Fecha de nacimiento de su padre', type: 'date' },
      { id: 'padreEnEEUU', label: '¿Su padre se encuentra en los Estados Unidos?', type: 'yesno' },
      { id: 'madreNombreCompleto', label: 'Nombre completo de su madre', type: 'text' },
      { id: 'madreFechaNacimiento', label: 'Fecha de nacimiento de su madre', type: 'date' },
      { id: 'madreEnEEUU', label: '¿Su madre se encuentra en los Estados Unidos?', type: 'yesno' },
      { id: 'parientesInmediatosEEUU', label: '¿Tiene parientes inmediatos en los Estados Unidos?', type: 'yesno', detailLabel: 'Detalla parentesco y nombre' },
      { id: 'otroParienteEEUU', label: '¿Tiene algún otro pariente en los Estados Unidos?', type: 'yesno', detailLabel: 'Detalla parentesco y nombre' },
    ],
  },
  {
    id: 'trabajo',
    title: 'Trabajo / Educación Actual',
    fields: [
      { id: 'ocupacion', label: 'Ocupación', type: 'text' },
      { id: 'domicilioEmpresa', label: 'Domicilio de empresa donde labora', type: 'text' },
      { id: 'empresaCiudad', label: 'Ciudad', type: 'text' },
      { id: 'empresaEstado', label: 'Estado', type: 'text' },
      { id: 'empresaCodigoPostal', label: 'Código postal', type: 'text' },
      { id: 'fechaInicioLabores', label: 'Fecha de inicio de labores en esta empresa', type: 'date' },
      { id: 'telefonoEmpresa', label: 'Número de teléfono de la empresa', type: 'tel' },
      { id: 'salarioMensual', label: 'Salario mensual actual', type: 'text' },
      { id: 'funciones', label: 'Describe tus funciones', type: 'textarea' },
      { id: 'empleadoOtraEmpresaPrev', label: '¿Estuviste empleado en otra empresa previamente?', type: 'yesno' },
    ],
  },
  {
    id: 'trabajoAnterior',
    title: 'Empleo Anterior y Educación',
    fields: [
      { id: 'ocupacionAnterior', label: 'Ocupación', type: 'text' },
      { id: 'domicilioEmpresaAnterior', label: 'Domicilio de empresa donde laboró anteriormente', type: 'text' },
      { id: 'tituloPosicion', label: 'Título de posición', type: 'text' },
      { id: 'nombreSupervisor', label: 'Nombre de su supervisor', type: 'text' },
      { id: 'fechaInicioFinAnterior', label: 'Fecha de inicio y final de su estancia en esta empresa', type: 'text' },
      { id: 'empresaAnteriorCiudad', label: 'Ciudad', type: 'text' },
      { id: 'empresaAnteriorEstado', label: 'Estado', type: 'text' },
      { id: 'empresaAnteriorCodigoPostal', label: 'Código postal', type: 'text' },
      { id: 'telefonoEmpresaAnterior', label: 'Número de teléfono de la empresa', type: 'tel' },
      { id: 'salarioMensualAnterior', label: 'Salario mensual', type: 'text' },
      { id: 'funcionesAnterior', label: 'Describe tus funciones', type: 'textarea' },
      { id: 'estudiosPreparatoriaOMayor', label: '¿Atendiste alguna institución de educación en un nivel de preparatoria o mayor?', type: 'yesno' },
      { id: 'institucionNombre', label: 'Nombre de la institución', type: 'text' },
      { id: 'institucionDomicilio', label: 'Domicilio de la institución', type: 'text' },
      { id: 'institucionCiudad', label: 'Ciudad', type: 'text' },
      { id: 'institucionCodigoPostal', label: 'Código postal', type: 'text' },
      { id: 'institucionEstado', label: 'Estado', type: 'text' },
      { id: 'institucionPais', label: 'País', type: 'text' },
      { id: 'carreraEstudiada', label: 'Carrera estudiada', type: 'text' },
      { id: 'fechaInicioEstudios', label: 'Fecha de inicio', type: 'date' },
      { id: 'fechaSalidaEstudios', label: 'Fecha de salida', type: 'date' },
    ],
  },
  {
    id: 'adicional',
    title: 'Información Adicional',
    fields: [
      { id: 'clanTribu', label: '¿Perteneces a un clan o tribu?', type: 'yesno', detailLabel: 'Detalla' },
      { id: 'idiomas', label: 'Proporciona una lista de los lenguajes que hablas', type: 'text' },
      { id: 'viajadoOtroPaisUltimos2Meses', label: '¿Has viajado a algún otro país en los últimos 2 meses?', type: 'yesno', detailLabel: 'Detalla' },
      { id: 'perteneceAsociacionSinFines', label: '¿Has pertenecido o contribuido a alguna asociación sin fines de lucro?', type: 'yesno', detailLabel: 'Detalla' },
      { id: 'habilidadArmasExplosivos', label: '¿Tienes alguna habilidad especializada en uso de armas, explosivos, nucleares, biológicos o químicos?', type: 'yesno', detailLabel: 'Detalla' },
      { id: 'servidoEjercito', label: '¿Has servido en el ejército?', type: 'yesno', detailLabel: 'Detalla' },
      { id: 'grupoParamilitar', label: '¿Alguna vez has estado en un grupo paramilitar / rebelde / guerrilla?', type: 'yesno', detailLabel: 'Detalla' },
      { id: 'enfermedadSaludPublica', label: '¿Tienes alguna enfermedad de importancia para la salud pública?', type: 'yesno', detailLabel: 'Detalla' },
      { id: 'desordenMentalFisico', label: '¿Tienes algún desorden mental o físico que pueda provocar algún riesgo/peligro para tu salud propia o de los demás?', type: 'yesno', detailLabel: 'Detalla' },
      { id: 'adiccionSustancia', label: '¿Alguna vez has sido adicto a alguna sustancia ilícita?', type: 'yesno', detailLabel: 'Detalla' },
      { id: 'arrestadoCrimen', label: '¿Alguna vez has sido arrestado por algún crimen?', type: 'yesno', detailLabel: 'Detalla' },
      { id: 'conspiradoSustanciasControladas', label: '¿Alguna vez has conspirado para romper alguna ley respecto a sustancias controladas (medicinas, drogas)?', type: 'yesno', detailLabel: 'Detalla' },
    ],
  },
];

const DOCUMENT_CATEGORIES = [
  { value: 'pasaporte', label: 'Pasaporte (escaneo o foto)' },
  { value: 'identificacion', label: 'Identificación oficial' },
  { value: 'foto_visa', label: 'Fotografía tipo visa' },
  { value: 'comprobante_domicilio', label: 'Comprobante de domicilio' },
  { value: 'comprobante_economico', label: 'Comprobante económico / laboral' },
  { value: 'acta_nacimiento', label: 'Acta de nacimiento' },
  { value: 'otro', label: 'Otro documento' },
];

function flatFieldIds() {
  return SECTIONS.flatMap((s) => s.fields.map((f) => `${s.id}.${f.id}`));
}

module.exports = { SECTIONS, DOCUMENT_CATEGORIES, SI_NO, flatFieldIds };
